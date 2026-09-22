const store = require("./db");

// LmsAnalyticsService: every number a teacher sees is computed here, from
// the same tables the rest of the LMS already writes to -- never a
// separately-tracked "analytics" record that could drift from what
// actually happened. Section 99 is explicit that mock analytics
// ("const analytics = [...]") is exactly the kind of thing this project
// must not ship; every function below reads real rows.

// Section 57: "do not create excessive activity rows merely to implement
// last activity if an aggregate field is sufficient." Rather than a
// dedicated activity-log table, this takes the max of the timestamps
// already being written by lesson completion, video progress, quiz
// attempts and assignment submissions -- the same signals Section 57
// names ("lesson opened" is approximated by video progress/completion,
// since this app doesn't log page views separately) -- and returns the
// most recent one, or null if the learner has done nothing at all yet in
// this course.
function lastActivityForLearner(courseId, learnerId, precomputed) {
  const { lessonIds, completions, videoProgress, quizAttempts, submissions } = precomputed;
  const timestamps = [
    ...completions.filter((c) => c.learnerId === learnerId && lessonIds.has(c.lessonId)).map((c) => c.completedAt),
    ...videoProgress.filter((p) => p.learnerId === learnerId && lessonIds.has(p.lessonId)).map((p) => p.updatedAt),
    ...quizAttempts.filter((a) => a.learnerId === learnerId).map((a) => a.submittedAt || a.startedAt),
    ...submissions.filter((s) => s.learnerId === learnerId).map((s) => s.submittedAt),
  ].filter(Boolean);
  if (timestamps.length === 0) return null;
  return timestamps.sort().slice(-1)[0];
}

// One pass over every table this needs, done once per course-analytics
// request rather than once per student inside a loop -- Section 84's
// explicit "avoid... loading all students unnecessarily" and "N+1
// queries" warning applies to this in-memory store exactly the way it
// would to a real SQL N+1: computing a course's full roster of lesson/
// quiz/assignment rows once and reusing them for every student in that
// course, instead of re-reading the same tables per student.
function courseAnalytics(courseId) {
  const modules = store.readAll("lms_modules").filter((m) => m.courseId === courseId);
  const moduleIds = new Set(modules.map((m) => m.id));
  const lessons = store.readAll("lms_lessons").filter((l) => moduleIds.has(l.moduleId) && l.isPublished);
  const lessonIds = new Set(lessons.map((l) => l.id));
  const contentLessons = lessons.filter((l) => !["QUIZ", "ASSIGNMENT"].includes(l.contentType));
  const quizLessons = lessons.filter((l) => l.contentType === "QUIZ");
  const assignmentLessons = lessons.filter((l) => l.contentType === "ASSIGNMENT");

  const quizzes = store.readAll("lms_quizzes").filter((q) => lessonIds.has(q.lessonId));
  const quizIds = new Set(quizzes.map((q) => q.id));
  const assignments = store.readAll("lms_assignments").filter((a) => lessonIds.has(a.lessonId));
  const assignmentIds = new Set(assignments.map((a) => a.id));

  const completions = store.readAll("lms_lesson_completions").filter((c) => lessonIds.has(c.lessonId));
  const videoProgress = store.readAll("lms_video_progress").filter((p) => lessonIds.has(p.lessonId));
  const quizAttempts = store.readAll("lms_quiz_attempts").filter((a) => quizIds.has(a.quizId));
  const submissions = store.readAll("lms_assignment_submissions").filter((s) => assignmentIds.has(s.assignmentId));

  const registrations = store.readAll("registrations").filter((r) =>
    r.courseId === courseId && (r.status === "confirmed" || r.status === "invoice_pending")
  );
  // Two registrations for the same learner (a resend, a corporate
  // re-invoice) must count as one enrolled student, not two -- dedupe by
  // learnerId, falling back to email for a registration that predates a
  // learner account existing.
  const learnerKeys = new Set();
  const enrolledLearnerIds = [];
  registrations.forEach((r) => {
    const key = r.learnerId || r.email.toLowerCase();
    if (!learnerKeys.has(key)) { learnerKeys.add(key); if (r.learnerId) enrolledLearnerIds.push(r.learnerId); }
  });

  const precomputed = { lessonIds, completions, videoProgress, quizAttempts, submissions };
  const totalRequired = contentLessons.length + quizLessons.length + assignmentLessons.length;

  const students = enrolledLearnerIds.map((learnerId) => {
    const learner = store.findOne("learners", (l) => l.id === learnerId);
    const contentDone = contentLessons.filter((l) => completions.some((c) => c.lessonId === l.id && c.learnerId === learnerId)).length;
    const quizzesPassed = quizLessons.filter((l) => {
      const quiz = quizzes.find((q) => q.lessonId === l.id);
      return quiz && quizAttempts.some((a) => a.quizId === quiz.id && a.learnerId === learnerId && a.passed === true);
    }).length;
    const assignmentsSubmitted = assignmentLessons.filter((l) => {
      const assignment = assignments.find((a) => a.lessonId === l.id);
      return assignment && submissions.some((s) => s.assignmentId === assignment.id && s.learnerId === learnerId);
    }).length;
    const doneCount = contentDone + quizzesPassed + assignmentsSubmitted;
    const progressPercent = totalRequired > 0 ? Math.round((doneCount / totalRequired) * 100) : 0;
    const lastActivity = lastActivityForLearner(courseId, learnerId, precomputed);
    const isActive = lastActivity && (Date.now() - new Date(lastActivity).getTime()) < 30 * 24 * 60 * 60 * 1000;
    const isComplete = totalRequired > 0 && doneCount === totalRequired;
    const learnerQuizAttempts = quizAttempts.filter((a) => a.learnerId === learnerId && a.percentage != null);
    const avgQuizScore = learnerQuizAttempts.length
      ? learnerQuizAttempts.reduce((sum, a) => sum + a.percentage, 0) / learnerQuizAttempts.length
      : null;
    return {
      learner, progressPercent, lastActivity, isActive, isComplete,
      quizAttemptsCount: learnerQuizAttempts.length, avgQuizScore,
      assignmentsSubmitted, assignmentsTotal: assignmentLessons.length,
    };
  });

  const allQuizPercentages = quizAttempts.filter((a) => a.percentage != null).map((a) => a.percentage);
  const totalAssignmentSlots = assignmentLessons.length * students.length;
  const totalAssignmentSubmissions = students.reduce((sum, s) => sum + s.assignmentsSubmitted, 0);

  return {
    enrolledCount: students.length,
    activeCount: students.filter((s) => s.isActive).length,
    completedCount: students.filter((s) => s.isComplete).length,
    completionRate: students.length ? Math.round((students.filter((s) => s.isComplete).length / students.length) * 100) : 0,
    averageProgress: students.length ? Math.round(students.reduce((sum, s) => sum + s.progressPercent, 0) / students.length) : 0,
    averageQuizScore: allQuizPercentages.length ? Math.round(allQuizPercentages.reduce((a, b) => a + b, 0) / allQuizPercentages.length) : null,
    assignmentSubmissionRate: totalAssignmentSlots > 0 ? Math.round((totalAssignmentSubmissions / totalAssignmentSlots) * 100) : null,
    lastActivity: students.map((s) => s.lastActivity).filter(Boolean).sort().slice(-1)[0] || null,
    students,
    totalRequired,
  };
}

module.exports = { courseAnalytics };

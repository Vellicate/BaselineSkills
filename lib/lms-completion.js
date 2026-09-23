const store = require("./db");
const certificates = require("./certificates");

// Ordered (module position, then lesson position) list of a course's
// published lessons, split by content type -- the one place "what counts
// as a required learning item in this course" is defined, so
// isCourseComplete and courseProgressForLearner (below) can't drift
// apart from each other the way a second, separately-written definition
// risked doing.
function orderedPublishedLessons(courseId) {
  const modules = store.readAll("lms_modules").filter((m) => m.courseId === courseId).sort((a, b) => a.position - b.position);
  const moduleIds = new Set(modules.map((m) => m.id));
  return store.readAll("lms_lessons")
    .filter((l) => moduleIds.has(l.moduleId) && l.isPublished)
    .sort((a, b) => {
      const modA = modules.find((m) => m.id === a.moduleId);
      const modB = modules.find((m) => m.id === b.moduleId);
      return modA.position - modB.position || a.position - b.position;
    });
}

function isLessonDoneForLearner(lesson, learnerId) {
  if (lesson.contentType === "QUIZ") {
    const quiz = store.findOne("lms_quizzes", (q) => q.lessonId === lesson.id);
    return !!(quiz && store.findOne("lms_quiz_attempts", (a) => a.quizId === quiz.id && a.learnerId === learnerId && a.passed === true));
  }
  if (lesson.contentType === "ASSIGNMENT") {
    const assignment = store.findOne("lms_assignments", (a) => a.lessonId === lesson.id);
    return !!(assignment && store.findOne("lms_assignment_submissions", (s) => s.assignmentId === assignment.id && s.learnerId === learnerId));
  }
  return !!store.findOne("lms_lesson_completions", (c) => c.lessonId === lesson.id && c.learnerId === learnerId);
}

// Part D/N: progress computed from actual records, never trusted from the
// client. Also returns the next incomplete lesson in course order, for
// the dashboard's "Continue Learning" / "next lesson" display -- kept as
// its own lean, single-learner, single-course query path rather than
// reusing lib/lms-analytics.js's course-wide-all-students loop, which is
// optimized for a different access pattern (many students, one course)
// and would reintroduce the N+1 pattern Part AK warns against if called
// once per course a student happens to be enrolled in.
function courseProgressForLearner(learnerId, courseId) {
  const lessons = orderedPublishedLessons(courseId);
  const doneMap = lessons.map((l) => ({ lesson: l, done: isLessonDoneForLearner(l, learnerId) }));
  const doneCount = doneMap.filter((d) => d.done).length;
  const nextLesson = (doneMap.find((d) => !d.done) || {}).lesson || null;
  return {
    totalRequired: lessons.length,
    doneCount,
    percentComplete: lessons.length ? Math.round((doneCount / lessons.length) * 100) : 0,
    nextLesson,
  };
}

// LmsCompletionService (Part Y): the one place "is this course complete for
// this student" is decided, and the one place completion is *processed*
// (persisted + certificate/badge issued).
function isCourseComplete(learnerId, courseId) {
  const progress = courseProgressForLearner(learnerId, courseId);
  return progress.totalRequired > 0 && progress.doneCount === progress.totalRequired;
}

// Reuses the existing enrollment_progress table (Part AG: "extend existing
// models whenever possible") rather than a new completion table -- it
// already has exactly the shape this needs (learnerId, courseId,
// percentComplete, completedAt), and was already being written by the
// admin's manual "mark registration complete" action for live/session
// courses. This is the same table, now also written automatically for
// LMS-driven completion. No unique constraint exists on
// (learnerId, courseId) at the database level, so uniqueness is enforced
// here instead: find the existing row for this pair and update it, never
// blindly insert a second one.
//
// Idempotent by construction (Part AC/Z): if a completion row already has
// completedAt set, this returns immediately without re-issuing a
// certificate -- issueCertificate() is independently idempotent too
// (it checks for an existing certificate before creating one), so even a
// concurrent double-call can't produce two certificates for the same
// learner+course.
async function checkAndProcessCompletion(learnerId, courseId, appBaseUrl) {
  const existingProgress = store.findOne("enrollment_progress", (p) =>
    p.learnerId === learnerId && p.courseId === courseId && !p.moduleId
  );
  if (existingProgress && existingProgress.completedAt) {
    return { alreadyComplete: true, justCompleted: false };
  }
  if (!isCourseComplete(learnerId, courseId)) {
    return { alreadyComplete: false, justCompleted: false };
  }

  const completedAt = new Date().toISOString();
  if (existingProgress) {
    store.update("enrollment_progress", existingProgress.id, { percentComplete: 100, completedAt });
  } else {
    store.insert("enrollment_progress", { learnerId, courseId, percentComplete: 100, completedAt });
  }
  await certificates.issueCertificate({ learnerId, courseId, appBaseUrl });
  return { alreadyComplete: false, justCompleted: true };
}

module.exports = { isCourseComplete, courseProgressForLearner, checkAndProcessCompletion };

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const store = require("./../lib/db");
const auth = require("./../lib/auth");
const security = require("./../lib/security");
const discounts = require("./../lib/discounts");
const { newId } = require("./../lib/id");
const lmsAccess = require("./../lib/lms-content-access");
const { LMS_SUBMISSION_DIR } = require("./../lib/lms-submission-storage");

const lmsCfg = discounts.loadConfig().security;

router.use(security.requireSameOrigin);

function modulesWithLessons(courseId) {
  return store.readAll("lms_modules")
    .filter((m) => m.courseId === courseId)
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      ...m,
      lessons: store.readAll("lms_lessons")
        .filter((l) => l.moduleId === m.id)
        .sort((a, b) => a.position - b.position)
        .map((l) => ({
          ...l,
          asset: store.findOne("lms_content_assets", (a) => a.lessonId === l.id) || null,
        })),
    }));
}

// Section 37: authenticated AND enrolled AND published AND within
// permitted dates -- except preview_enabled content, which may be seen by
// anyone. This loader is the single place that decides "can this visitor
// see this course's LMS content at all" so every route below shares one
// authorization path rather than five slightly-different copies of it.
// Not folded into LmsContentAccessService itself because that service is
// deliberately kept to pure, side-effect-free permission questions
// (canView/canDownload/canManage) -- this loader additionally renders the
// specific denial page, which is route-layer concern, not policy.
function loadAccessibleCourse(req, res, next) {
  const course = store.findOne("courses", (c) => c.id === req.params.courseId);
  if (!course || !course.lmsDeliveryMode) return res.status(404).render("404", { title: "Course not found" });

  // Checked before enrollment/preview at all -- Section 37 lists the date
  // window as its own top-level requirement, and Section 28 says a
  // student outside it "must receive an appropriate access response"
  // regardless of enrollment status. No need to even compute preview
  // eligibility if the window itself is closed to everyone.
  const windowStatus = lmsAccess.courseAccessWindowStatus(course);
  if (windowStatus !== "open") {
    return res.status(403).render("lms/access-denied", {
      title: "Access required — Baseline Skills",
      course,
      reason: windowStatus, // "not_started" or "ended"
    });
  }

  const learnerId = req.session.learnerId || null;
  const enrolled = lmsAccess.isEnrolled(learnerId, course.id);

  if (!enrolled) {
    const hasAnyPreview = modulesWithLessons(course.id).some((m) => m.lessons.some((l) => lmsAccess.canView(learnerId, l, course)));
    if (!hasAnyPreview) {
      if (!learnerId) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(403).render("lms/access-denied", {
        title: "Access required — Baseline Skills",
        course,
        reason: "not_enrolled",
      });
    }
  }
  req.lmsCourse = course;
  req.lmsEnrolled = enrolled;
  next();
}

router.get("/student/lms", auth.requireLearner, (req, res) => {
  const learner = store.findOne("learners", (l) => l.id === req.session.learnerId);
  const registrations = store.readAll("registrations").filter((r) =>
    (r.learnerId === learner.id || r.email.toLowerCase() === learner.email.toLowerCase()) &&
    (r.status === "confirmed" || r.status === "invoice_pending")
  );
  const courseIds = new Set(registrations.map((r) => r.courseId));
  const lmsCourses = store.readAll("courses").filter((c) => courseIds.has(c.id) && c.lmsDeliveryMode);

  const courseSummaries = lmsCourses.map((course) => {
    const modules = modulesWithLessons(course.id);
    const publishedLessons = modules.flatMap((m) => m.lessons.filter((l) => l.isPublished));
    const completions = store.readAll("lms_lesson_completions").filter((c) =>
      c.learnerId === learner.id && publishedLessons.some((l) => l.id === c.lessonId)
    );
    const progressPercent = publishedLessons.length
      ? Math.round((completions.length / publishedLessons.length) * 100)
      : 0;
    return { course, totalLessons: publishedLessons.length, completedLessons: completions.length, progressPercent };
  });

  res.render("lms/student-dashboard", { title: "My Learning — Baseline Skills", courseSummaries });
});

router.get("/student/lms/courses/:courseId", loadAccessibleCourse, (req, res) => {
  const learnerId = req.session.learnerId || null;
  const modules = modulesWithLessons(req.lmsCourse.id).map((m) => ({
    ...m,
    lessons: m.lessons.filter((l) => lmsAccess.canView(learnerId, l, req.lmsCourse)),
  }));
  const completedLessonIds = new Set(
    learnerId
      ? store.readAll("lms_lesson_completions").filter((c) => c.learnerId === learnerId).map((c) => c.lessonId)
      : []
  );
  const firstLesson = modules.flatMap((m) => m.lessons)[0] || null;
  const progress = learnerId && firstLesson
    ? store.findOne("lms_video_progress", (p) => p.lessonId === firstLesson.id && p.learnerId === learnerId)
    : null;
  res.render("lms/course-player", {
    title: `${req.lmsCourse.title} — Baseline Skills`,
    course: req.lmsCourse, modules, isTeacherPreview: false, activeLesson: null, completedLessonIds,
    videoResumePosition: progress ? progress.lastPositionSeconds : 0,
  });
});

router.get("/student/lms/courses/:courseId/lessons/:lessonId", loadAccessibleCourse, (req, res) => {
  const rawLesson = store.findOne("lms_lessons", (l) => l.id === req.params.lessonId);
  const learnerId = req.session.learnerId || null;
  if (!rawLesson || !lmsAccess.canView(learnerId, rawLesson, req.lmsCourse)) {
    return res.status(403).render("lms/access-denied", {
      title: "Access required — Baseline Skills", course: req.lmsCourse, reason: "lesson_locked",
    });
  }
  const modules = modulesWithLessons(req.lmsCourse.id).map((m) => ({
    ...m,
    lessons: m.lessons.filter((l) => lmsAccess.canView(learnerId, l, req.lmsCourse)),
  }));
  // Re-derived from the asset-attached modules array above, not the raw
  // rawLesson used only for the access-gate check -- store.findOne alone
  // doesn't attach lms_content_assets, which broke video/PDF rendering
  // (found by actually loading a video lesson and seeing "no file
  // uploaded yet" for a lesson that very much had one).
  const lesson = modules.flatMap((m) => m.lessons).find((l) => l.id === rawLesson.id) || rawLesson;
  const completedLessonIds = new Set(
    learnerId
      ? store.readAll("lms_lesson_completions").filter((c) => c.learnerId === learnerId).map((c) => c.lessonId)
      : []
  );
  const progress = learnerId
    ? store.findOne("lms_video_progress", (p) => p.lessonId === lesson.id && p.learnerId === learnerId)
    : null;
  res.render("lms/course-player", {
    title: `${lesson.title} — ${req.lmsCourse.title}`,
    course: req.lmsCourse, modules, isTeacherPreview: false, activeLesson: lesson, completedLessonIds,
    videoResumePosition: progress ? progress.lastPositionSeconds : 0,
  });
});

// Idempotent by design (Section 55's principle applied here too, not just
// certificates): the UNIQUE(lessonId, learnerId) constraint on
// lms_lesson_completions means a second "mark complete" for the same
// lesson either does nothing new or would throw on a naive insert --
// handled explicitly here rather than letting that surface as a raw
// constraint-violation 500.
// Shared by both the completion and video-progress endpoints below, which
// were duplicating the exact same "find lesson -> find owning course ->
// check canView" sequence -- Section 94's "avoid duplicated business
// logic" applies within a single route file, not just across the app.
function loadViewableLesson(req) {
  const lesson = store.findOne("lms_lessons", (l) => l.id === req.params.lessonId);
  if (!lesson) return { error: 404, message: "Lesson not found." };
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canView(req.session.learnerId, lesson, course)) {
    return { error: 403, message: "You don't have access to this lesson." };
  }
  return { lesson, course };
}

router.post("/student/lms/lessons/:lessonId/complete", auth.requireLearner, (req, res) => {
  const result = loadViewableLesson(req);
  if (result.error) return res.status(result.error).json({ error: result.message });
  const already = store.findOne("lms_lesson_completions", (c) =>
    c.lessonId === result.lesson.id && c.learnerId === req.session.learnerId
  );
  if (!already) {
    store.insert("lms_lesson_completions", {
      lessonId: result.lesson.id, learnerId: req.session.learnerId, completedAt: new Date().toISOString(),
    });
  }
  res.json({ ok: true, alreadyCompleted: !!already });
});

// Section 40: persist exact playback position, saved periodically/on
// pause/seek/visibility-change from the client -- this endpoint doesn't
// care which of those triggered the save, it just records whatever
// position it's given for this learner+lesson, upserting rather than
// accumulating a row per save (the UNIQUE(lessonId, learnerId) constraint
// makes a plain second insert fail, so this reads first rather than
// relying on the database to reject a duplicate).
router.post("/student/lms/lessons/:lessonId/video-progress", auth.requireLearner, (req, res) => {
  const result = loadViewableLesson(req);
  if (result.error) return res.status(result.error).json({ error: result.message });
  const position = Number(req.body.positionSeconds);
  if (!Number.isFinite(position) || position < 0) return res.status(400).json({ error: "Invalid position." });
  const existing = store.findOne("lms_video_progress", (p) =>
    p.lessonId === result.lesson.id && p.learnerId === req.session.learnerId
  );
  if (existing) {
    store.update("lms_video_progress", existing.id, { lastPositionSeconds: position, updatedAt: new Date().toISOString() });
  } else {
    store.insert("lms_video_progress", {
      lessonId: result.lesson.id, learnerId: req.session.learnerId,
      lastPositionSeconds: position, updatedAt: new Date().toISOString(),
    });
  }
  res.json({ ok: true });
});

// ==================== Quiz player ====================
const quizLib = require("./../lib/lms-quiz");

function quizForLesson(lessonId) {
  const quiz = store.findOne("lms_quizzes", (q) => q.lessonId === lessonId);
  if (!quiz) return null;
  const caseStudies = store.readAll("lms_case_studies").filter((c) => c.quizId === quiz.id);
  const questions = store.readAll("lms_questions").filter((q) => q.quizId === quiz.id).sort((a, b) => a.position - b.position)
    .map((q) => ({ ...q, options: store.readAll("lms_question_options").filter((o) => o.questionId === q.id).sort((a, b) => a.position - b.position) }));
  return { quiz, caseStudies, questions };
}

// Shared ownership check for every /student/lms/attempts/:attemptId route
// below -- an attempt belongs to exactly one learner, and Section 64's
// IDOR test list explicitly names quiz attempts as something to check
// ("Can students submit answers after expiration? ... Can Student A
// update Student B's submission?" -- the same principle for quizzes).
function loadOwnAttempt(req) {
  const attempt = store.findOne("lms_quiz_attempts", (a) => a.id === req.params.attemptId);
  if (!attempt || attempt.learnerId !== req.session.learnerId) return { error: 404 };
  const quiz = store.findOne("lms_quizzes", (q) => q.id === attempt.quizId);
  const lesson = store.findOne("lms_lessons", (l) => l.id === quiz.lessonId);
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = store.findOne("courses", (c) => c.id === mod.courseId);
  if (!lmsAccess.canView(req.session.learnerId, lesson, course)) return { error: 403 };
  return { attempt, quiz, lesson, course };
}

router.get("/student/lms/lessons/:lessonId/quiz", auth.requireLearner, (req, res) => {
  const result = loadViewableLesson(req);
  if (result.error) return res.status(result.error).send(result.message);
  const details = quizForLesson(result.lesson.id);
  if (!details) return res.status(404).render("404", { title: "Quiz not found" });
  const attempts = store.readAll("lms_quiz_attempts")
    .filter((a) => a.quizId === details.quiz.id && a.learnerId === req.session.learnerId)
    .sort((a, b) => b.attemptNumber - a.attemptNumber);
  const inProgress = attempts.find((a) => a.status === "IN_PROGRESS");
  const attemptsUsed = quizLib.countAttempts(details.quiz.id, req.session.learnerId);
  res.render("lms/student-quiz-landing", {
    title: `${result.lesson.title} — ${result.course.title}`,
    course: result.course, lesson: result.lesson, quiz: details.quiz, questions: details.questions,
    attempts, inProgress, attemptsUsed, attemptsRemaining: Math.max(0, details.quiz.maxAttempts - attemptsUsed),
  });
});

// Section 47: checked here, before the attempt row is even created --
// countAttempts() includes every attempt regardless of status (an
// EXPIRED or abandoned IN_PROGRESS attempt still counts against the
// limit, matching "completed + active attempts < max_attempts" reading
// active as anything that isn't a fresh slot).
router.post("/student/lms/lessons/:lessonId/quiz/start", auth.requireLearner, (req, res) => {
  const result = loadViewableLesson(req);
  if (result.error) return res.status(result.error).send(result.message);
  const details = quizForLesson(result.lesson.id);
  if (!details) return res.status(404).send("Quiz not found.");

  const existingInProgress = store.findOne("lms_quiz_attempts", (a) =>
    a.quizId === details.quiz.id && a.learnerId === req.session.learnerId && a.status === "IN_PROGRESS"
  );
  if (existingInProgress) return res.redirect(`/student/lms/attempts/${existingInProgress.id}`);

  const attemptsUsed = quizLib.countAttempts(details.quiz.id, req.session.learnerId);
  if (attemptsUsed >= details.quiz.maxAttempts) {
    return res.status(403).send("You've used all your attempts for this quiz.");
  }
  const startedAt = new Date();
  const expiresAt = details.quiz.timeLimitSeconds
    ? new Date(startedAt.getTime() + details.quiz.timeLimitSeconds * 1000).toISOString()
    : null;
  const attempt = store.insert("lms_quiz_attempts", {
    quizId: details.quiz.id, learnerId: req.session.learnerId, attemptNumber: attemptsUsed + 1,
    startedAt: startedAt.toISOString(), expiresAt, status: "IN_PROGRESS",
  });
  res.redirect(`/student/lms/attempts/${attempt.id}`);
});

router.get("/student/lms/attempts/:attemptId", auth.requireLearner, (req, res) => {
  const result = loadOwnAttempt(req);
  if (result.error) return res.status(result.error).render("404", { title: "Attempt not found" });
  if (result.attempt.status !== "IN_PROGRESS") return res.redirect(`/student/lms/attempts/${result.attempt.id}/result`);
  const details = quizForLesson(result.lesson.id);
  const existingAnswers = store.readAll("lms_quiz_answers").filter((a) => a.attemptId === result.attempt.id);
  res.render("lms/student-quiz-take", {
    title: `${result.lesson.title} — ${result.course.title}`,
    attempt: result.attempt, quiz: details.quiz, caseStudies: details.caseStudies, questions: details.questions,
    existingAnswers,
  });
});

// Section 45: answerData is stored as the structured value the client
// sends (a single option id, an array of option ids, or free text) --
// never re-derived from display text. Section 64's "can students submit
// answers after expiration?" is checked here, not just at final submit,
// since a determined client could otherwise keep calling this endpoint
// past the deadline even if the submit endpoint alone were guarded.
router.post("/student/lms/attempts/:attemptId/answers", auth.requireLearner, (req, res) => {
  const result = loadOwnAttempt(req);
  if (result.error) return res.status(result.error).json({ error: "Not found." });
  if (result.attempt.status !== "IN_PROGRESS") return res.status(400).json({ error: "This attempt is no longer in progress." });
  if (result.attempt.expiresAt && new Date() > new Date(result.attempt.expiresAt)) {
    // Deliberately not mutating status here -- the check itself is what
    // blocks the save, and IN_PROGRESS is left alone so the take page
    // (which redirects away from anything not IN_PROGRESS) still lets the
    // student reach the submit button after time runs out, and so the
    // submit route's own expiry handling is the single place that
    // actually finalizes the attempt's real status via scoreAttempt().
    // An earlier version set status to EXPIRED here, which then made
    // submit's "already submitted" guard permanently refuse to finalize
    // or score the attempt at all -- found by actually letting an
    // attempt expire mid-answer and trying to submit afterward, not by
    // reading the two routes' guards side by side.
    return res.status(403).json({ error: "Time's up for this attempt." });
  }
  const questionId = req.body.questionId;
  const questionRow = store.findOne("lms_questions", (q) => q.id === questionId && q.quizId === result.quiz.id);
  if (!questionRow) return res.status(400).json({ error: "That question doesn't belong to this quiz." });

  // The client-side checkbox-disabling in student-quiz-take.ejs is a UX
  // guardrail only -- this is the real enforcement, since a request can
  // always be sent directly regardless of what the page's own JS allowed
  // through. A MULTI_SELECT answer with more selections than there are
  // correct options is never a legitimate answer to save, regardless of
  // which options were picked.
  if (questionRow.questionType === "MULTI_SELECT") {
    const correctCount = store.readAll("lms_question_options").filter((o) => o.questionId === questionRow.id && o.isCorrect).length;
    const selectedCount = Array.isArray(req.body.answerData) ? req.body.answerData.length : 0;
    if (selectedCount > correctCount) {
      return res.status(400).json({ error: `You can select at most ${correctCount} option${correctCount === 1 ? "" : "s"} for this question.` });
    }
  }

  const existing = store.findOne("lms_quiz_answers", (a) => a.attemptId === result.attempt.id && a.questionId === questionId);
  if (existing) {
    store.update("lms_quiz_answers", existing.id, { answerData: req.body.answerData });
  } else {
    store.insert("lms_quiz_answers", { attemptId: result.attempt.id, questionId, answerData: req.body.answerData });
  }
  res.json({ ok: true });
});

// Section 46: the server's own clock, never the client's, decides
// expiry. Scoring an already-expired attempt on submit is deliberate,
// not a gap -- the answers already saved before the deadline still
// count; expiry blocks *further* answering (enforced above), not the
// final scoring of what was legitimately saved in time.
router.post("/student/lms/attempts/:attemptId/submit", auth.requireLearner, (req, res) => {
  const result = loadOwnAttempt(req);
  if (result.error) return res.status(result.error).json({ error: "Not found." });
  // EXPIRED is not a terminal state here -- it's set as a side effect by
  // the answers route when it notices time ran out mid-answer, and still
  // needs to go through scoring/finalization exactly like a normal
  // in-time submission. Only a genuinely already-finalized attempt
  // (SUBMITTED, or PENDING_MANUAL_GRADING while a short-answer question
  // is still ungraded) should refuse a second submit. Found by actually
  // hitting this sequence -- answer-save flips to EXPIRED, then a
  // same-attempt submit call was rejected as "already submitted" and the
  // attempt could never be finalized or scored at all.
  if (["SUBMITTED", "PENDING_MANUAL_GRADING"].includes(result.attempt.status)) {
    return res.status(400).json({ error: "This attempt has already been submitted." });
  }
  const isLate = !!(result.attempt.expiresAt && new Date() > new Date(result.attempt.expiresAt));
  store.update("lms_quiz_attempts", result.attempt.id, { submittedAt: new Date().toISOString() });

  // Score every answer against its question's authoritative options --
  // never trusting any score the client might have sent (Section 22),
  // which is why this loop doesn't read req.body for anything at all.
  const answers = store.readAll("lms_quiz_answers").filter((a) => a.attemptId === result.attempt.id);
  answers.forEach((answer) => {
    const question = store.findOne("lms_questions", (q) => q.id === answer.questionId);
    const options = store.readAll("lms_question_options").filter((o) => o.questionId === question.id);
    const scored = quizLib.scoreAnswer(question, options, answer.answerData, result.quiz.negativeMarkingEnabled);
    store.update("lms_quiz_answers", answer.id, scored);
  });
  const scoredAttempt = quizLib.scoreAttempt(result.attempt.id);
  // Marked EXPIRED only now, after scoring, and only if scoreAttempt
  // landed on SUBMITTED -- a late submission that still has an
  // outstanding short-answer question stays PENDING_MANUAL_GRADING
  // (that takes priority; being late doesn't change what a teacher still
  // needs to grade).
  if (isLate && scoredAttempt.status === "SUBMITTED") {
    store.update("lms_quiz_attempts", result.attempt.id, { status: "EXPIRED" });
  }
  res.json({ ok: true, resultUrl: `/student/lms/attempts/${result.attempt.id}/result` });
});

router.get("/student/lms/attempts/:attemptId/result", auth.requireLearner, (req, res) => {
  const result = loadOwnAttempt(req);
  if (result.error) return res.status(result.error).render("404", { title: "Attempt not found" });
  if (result.attempt.status === "IN_PROGRESS") return res.redirect(`/student/lms/attempts/${result.attempt.id}`);
  res.render("lms/student-quiz-result", {
    title: `Result — ${result.lesson.title}`,
    course: result.course, lesson: result.lesson, quiz: result.quiz, attempt: result.attempt,
  });
});

// Section 24: question, student's answer, correct answer (per the quiz's
// showCorrectAnswers policy), correct/wrong status, marks awarded, plus
// next/previous-wrong-answer navigation via a query param rather than a
// separate route per question, since "which wrong answer" is really just
// "which position in the filtered wrong-answers list", not a distinct
// resource.
router.get("/student/lms/attempts/:attemptId/review", auth.requireLearner, (req, res) => {
  const result = loadOwnAttempt(req);
  if (result.error) return res.status(result.error).render("404", { title: "Attempt not found" });
  if (result.attempt.status === "IN_PROGRESS") return res.redirect(`/student/lms/attempts/${result.attempt.id}`);
  const details = quizForLesson(result.lesson.id);
  const answers = store.readAll("lms_quiz_answers").filter((a) => a.attemptId === result.attempt.id);
  const questionsWithAnswers = details.questions.map((q) => ({
    ...q, answer: answers.find((a) => a.questionId === q.id) || null,
  }));
  res.render("lms/student-quiz-review", {
    title: `Review — ${result.lesson.title}`,
    course: result.course, lesson: result.lesson, quiz: result.quiz, attempt: result.attempt,
    caseStudies: details.caseStudies, questionsWithAnswers,
  });
});

const submissionUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LMS_SUBMISSION_DIR),
    filename: (req, file, cb) => cb(null, `${newId("lmssubmission")}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    // req.lmsAssignment is attached by loadSubmittableAssignment, which
    // always runs before this multer middleware -- allowedFileTypes is
    // per-assignment (Section 26), teacher-configured, not a fixed global
    // allowlist the way lesson-content uploads are.
    const allowed = (req.lmsAssignment.allowedFileTypes || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error(`File type not allowed. This assignment accepts: ${req.lmsAssignment.allowedFileTypes}`));
    }
    cb(null, true);
  },
  // A generous safety-net ceiling, not the real per-assignment limit --
  // multer's limits.fileSize is fixed at configuration time and can't
  // vary per request, so the assignment's own, teacher-set maxFileSizeMB
  // is checked explicitly in the route handler after upload, which can
  // reject and delete an otherwise-multer-accepted file that's still too
  // big for *this* assignment specifically.
  limits: { fileSize: lmsCfg.LMS_DOCUMENT_MAX_FILE_SIZE_MB * 1024 * 1024 },
});

function loadSubmittableAssignment(req) {
  const lesson = store.findOne("lms_lessons", (l) => l.id === req.params.lessonId);
  if (!lesson) return { error: 404, message: "Lesson not found." };
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canView(req.session.learnerId, lesson, course)) {
    return { error: 403, message: "You don't have access to this lesson." };
  }
  const assignment = store.findOne("lms_assignments", (a) => a.lessonId === lesson.id);
  if (!assignment) return { error: 404, message: "Assignment not found." };
  return { lesson, course, assignment };
}

router.get("/student/lms/lessons/:lessonId/assignment", auth.requireLearner, (req, res) => {
  const result = loadSubmittableAssignment(req);
  if (result.error) return res.status(result.error).send(result.message);
  const submissions = store.readAll("lms_assignment_submissions")
    .filter((s) => s.assignmentId === result.assignment.id && s.learnerId === req.session.learnerId)
    .sort((a, b) => b.submissionNumber - a.submissionNumber);
  res.render("lms/student-assignment", {
    title: `${result.lesson.title} — ${result.course.title}`,
    course: result.course, lesson: result.lesson, assignment: result.assignment, submissions,
  });
});

// Section 27: never overwrites a prior submission -- always a new row
// with the next submissionNumber. Section 49: lateness is determined by
// the server's own clock against the assignment's deadline, not
// anything the client claims, and persisted on the row so it can't
// silently change after the fact.
router.post("/student/lms/lessons/:lessonId/assignment/submit", auth.requireLearner, (req, res, next) => {
  const preCheck = loadSubmittableAssignment(req);
  if (preCheck.error) return res.status(preCheck.error).send(preCheck.message);
  req.lmsAssignment = preCheck.assignment;

  const existingCount = store.readAll("lms_assignment_submissions")
    .filter((s) => s.assignmentId === preCheck.assignment.id && s.learnerId === req.session.learnerId).length;
  if (existingCount > 0 && !preCheck.assignment.allowResubmission) {
    return res.status(403).send("This assignment doesn't allow resubmission, and you've already submitted.");
  }

  submissionUpload.single("submissionFile")(req, res, (err) => {
    if (err) return res.status(400).send(err.message);
    if (!req.file) return res.status(400).send("A file is required.");
    if (req.file.size > preCheck.assignment.maxFileSizeMB * 1024 * 1024) {
      fs.unlinkSync(req.file.path);
      return res.status(400).send(`File exceeds the ${preCheck.assignment.maxFileSizeMB}MB limit for this assignment.`);
    }
    const isLate = !!(preCheck.assignment.deadline && new Date() > new Date(preCheck.assignment.deadline));
    store.insert("lms_assignment_submissions", {
      assignmentId: preCheck.assignment.id, learnerId: req.session.learnerId,
      submissionNumber: existingCount + 1, submittedAt: new Date().toISOString(), isLate,
      storageKey: req.file.filename, originalFilename: req.file.originalname,
      mimeType: req.file.mimetype, sizeBytes: req.file.size,
    });
    res.redirect(`/student/lms/lessons/${preCheck.lesson.id}/assignment`);
  });
});

router.get("/student/lms/submissions/:submissionId/download", auth.requireLearner, (req, res) => {
  const submission = store.findOne("lms_assignment_submissions", (s) => s.id === req.params.submissionId);
  // A student may only download their own submission back -- Section 64's
  // "can Student A update Student B's submission?" applies just as much
  // to reading it back as updating it.
  if (!submission || submission.learnerId !== req.session.learnerId) {
    return res.status(404).render("404", { title: "Submission not found" });
  }
  const filePath = path.join(LMS_SUBMISSION_DIR, submission.storageKey);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: "Submission file not found" });
  res.download(filePath, submission.originalFilename || submission.storageKey);
});

module.exports = router;

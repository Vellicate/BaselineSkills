const store = require("./db");

// LmsQuizService: the one place quiz scoring actually happens. Section 22
// is explicit and absolute -- "Never trust score, correct answers, marks,
// pass status sent by the browser. The server must calculate... from
// persisted answers and the authoritative assessment configuration." No
// route computes a score itself; every one calls scoreAttempt() here,
// which re-derives everything from the quiz's own question/option rows,
// never from anything the client claims.

// Scores one already-persisted answer against its question's authoritative
// options. Returns { isCorrect, marksAwarded } -- both null for
// SHORT_ANSWER, which Section 25 requires a human to grade rather than
// auto-score.
function scoreAnswer(question, options, answerData, negativeMarkingEnabled) {
  if (question.questionType === "SHORT_ANSWER") {
    return { isCorrect: null, marksAwarded: null };
  }

  const correctIds = new Set(options.filter((o) => o.isCorrect).map((o) => o.id));

  let isCorrect;
  let marksAwarded;
  if (question.questionType === "MULTI_SELECT") {
    // Pro-rata: credit is proportional to how many of the correct options
    // were actually selected, out of however many correct options this
    // question has -- a question with 2 correct options where the learner
    // picks one correct and one wrong earns 50%, not 0%. isCorrect still
    // means an exact, perfect match (every correct option picked, no
    // incorrect one) -- that boolean is also used for review-page
    // correct/incorrect display and analytics, so its meaning is
    // preserved; marksAwarded is what actually carries the partial credit.
    // Negative marking only applies when the learner earned no partial
    // credit at all (selected zero correct options) -- once they've
    // gotten some of it right, this awards the fraction earned rather
    // than also penalizing on top of an already-reduced score.
    const selected = new Set(Array.isArray(answerData) ? answerData : []);
    const correctSelectedCount = [...selected].filter((id) => correctIds.has(id)).length;
    const incorrectSelectedCount = [...selected].filter((id) => !correctIds.has(id)).length;
    const fraction = correctIds.size > 0 ? correctSelectedCount / correctIds.size : 0;
    isCorrect = fraction === 1 && incorrectSelectedCount === 0;
    marksAwarded = isCorrect
      ? question.marks
      : fraction > 0
        ? question.marks * fraction
        : (negativeMarkingEnabled ? -question.negativeMarks : 0);
  } else {
    // MCQ and TRUE_FALSE: a single selected option id -- no partial credit
    // is possible or meaningful when there's only one answer to pick.
    isCorrect = typeof answerData === "string" && correctIds.has(answerData);
    marksAwarded = isCorrect
      ? question.marks
      : (negativeMarkingEnabled ? -question.negativeMarks : 0);
  }

  return { isCorrect, marksAwarded };
}

// Re-scores every answer for an attempt and updates the attempt's
// aggregate score/percentage/passed/status. Called on submission, and
// again after a teacher grades a short-answer question (Section 50/52's
// "student should see updated result... according to the application's
// workflow" -- here, immediately once every short-answer question in
// that attempt has a mark).
//
// Idempotent in the sense that matters: calling it twice with the same
// underlying data produces the same result, it doesn't accumulate or
// double-count anything, since it always recomputes from the full set of
// persisted answers rather than incrementing.
function scoreAttempt(attemptId) {
  const attempt = store.findOne("lms_quiz_attempts", (a) => a.id === attemptId);
  if (!attempt) return null;
  const quiz = store.findOne("lms_quizzes", (q) => q.id === attempt.quizId);
  const questions = store.readAll("lms_questions").filter((q) => q.quizId === quiz.id);
  const answers = store.readAll("lms_quiz_answers").filter((a) => a.attemptId === attemptId);

  let totalPossible = 0;
  let totalEarned = 0;
  let hasUngradedShortAnswer = false;

  questions.forEach((question) => {
    totalPossible += question.marks;
    const answer = answers.find((a) => a.questionId === question.id);
    if (!answer) return; // unanswered: 0 marks, already excluded from totalEarned by not adding anything

    if (question.questionType === "SHORT_ANSWER") {
      if (answer.marksAwarded == null) {
        hasUngradedShortAnswer = true;
      } else {
        totalEarned += answer.marksAwarded;
      }
      return;
    }
    totalEarned += answer.marksAwarded || 0;
  });

  const percentage = totalPossible > 0 ? (totalEarned / totalPossible) * 100 : 0;
  const passed = !hasUngradedShortAnswer ? percentage >= quiz.passPercentage : null;
  const status = hasUngradedShortAnswer ? "PENDING_MANUAL_GRADING" : "SUBMITTED";

  store.update("lms_quiz_attempts", attemptId, {
    score: totalEarned, percentage, passed, status,
  });
  return store.findOne("lms_quiz_attempts", (a) => a.id === attemptId);
}

// Section 47: "completed + active attempts < max_attempts must be
// checked server-side... prevent race conditions." better-sqlite3 runs
// synchronously and this whole app is single-process, so a plain read
// here-then-insert in the route is not actually racy in this deployment
// the way it would be under real concurrent connections/processes --
// still centralized here rather than duplicated per-route, and phrased so
// that if this app ever did move to a multi-process/worker model, the one
// place to add a real transaction/constraint is obvious.
function countAttempts(quizId, learnerId) {
  return store.readAll("lms_quiz_attempts").filter((a) => a.quizId === quizId && a.learnerId === learnerId).length;
}

module.exports = { scoreAnswer, scoreAttempt, countAttempts };

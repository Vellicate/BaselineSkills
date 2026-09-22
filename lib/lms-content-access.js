const store = require("./db");

// LmsContentAccessService: the one place that decides whether a given
// learner can view/download a given lesson. Every LMS route asks this
// service rather than re-implementing the check itself -- Section 61 and
// 94 of the LMS spec both call this out specifically (centralized
// authorization, not permission logic scattered across routes/EJS).
//
// The enrollment check reuses the exact pattern already proven in
// routes/public.js's /courses/:slug/materials/:materialId/download route:
// a learner has access to a course's content if they have a registration
// against that course with status "confirmed" or "invoice_pending" --
// there is no separate LMS enrollment table. This is a deliberate choice,
// not an oversight: the LMS spec's own closing "strategic recommendation"
// explicitly says to model this as Course -> Enrollment -> LMS Learning
// Experience, reusing the registration as the enrollment record rather
// than inventing a parallel one. If a genuinely distinct LMS-only
// enrollment concept (assigned-but-not-purchased, corporate bulk seats,
// etc.) becomes necessary later, it should extend this function's
// isEnrolled() check, not bypass this service.

function isEnrolled(learnerId, courseId) {
  if (!learnerId || !courseId) return false;
  const learner = store.findOne("learners", (l) => l.id === learnerId);
  if (!learner) return false;
  const qualifies = store.findOne("registrations", (r) =>
    r.courseId === courseId &&
    (r.learnerId === learner.id || r.email.toLowerCase() === learner.email.toLowerCase()) &&
    (r.status === "confirmed" || r.status === "invoice_pending")
  );
  return !!qualifies;
}

// Section 28: "Access must be controlled by server-side date validation
// ... A student outside the permitted date window must receive an
// appropriate access response." NULL on either bound means unrestricted
// in that direction. Returns a specific reason string, not just true/
// false, because Section 66 asks for distinct messages ("becomes
// available on..." vs "ended on...") rather than one generic denial --
// the caller needs to know *which* boundary was crossed to show the
// right one.
function courseAccessWindowStatus(course) {
  if (!course) return "ended";
  const now = new Date();
  if (course.lmsAccessStartDate && now < new Date(course.lmsAccessStartDate)) return "not_started";
  if (course.lmsAccessEndDate && now > new Date(course.lmsAccessEndDate)) return "ended";
  return "open";
}

// canView: may this learner (possibly anonymous, learnerId null) see this
// lesson's content at all? True if enrolled, OR if the lesson is marked
// preview_enabled -- Section 17/34's explicit carve-out for pre-enrollment
// preview access, which must still go through this same service rather
// than a separate, easier-to-get-wrong path.
//
// The date-window check runs first and applies to everyone, preview
// included -- Section 37 lists the preview exception specifically against
// the *enrollment* requirement ("Exceptions: preview_enabled content may
// be accessed by non-enrolled visitors"), not against the date-window
// requirement, so a course that hasn't started yet or has already ended
// has nothing previewable either, by the spec's own wording.
function canView(learnerId, lesson, course) {
  if (!lesson || !lesson.isPublished) return false;
  if (courseAccessWindowStatus(course) !== "open") return false;
  if (lesson.previewEnabled) return true;
  return isEnrolled(learnerId, course.id);
}

// canDownload: Section 16 is explicit that this is an authorization
// decision, not a UI decision -- a lesson with downloadAllowed=false must
// never have the backend issue a download URL at all, regardless of
// whether the requester could otherwise view/stream it.
function canDownload(learnerId, lesson, course) {
  if (!canView(learnerId, lesson, course)) return false;
  return !!lesson.downloadAllowed;
}

// canManage: may this instructor create/edit/reorder/publish content for
// this course? Deliberately NOT a new "Course Admin" or "Content Admin"
// role (explicitly forbidden by Section 2) -- it's the existing trainerId
// relationship already on the courses table, the same one that already
// determines which instructor's name and profile appear on a course page.
// Deliberately NOT date-gated -- the access window in
// courseAccessWindowStatus() is a student-facing restriction; a teacher
// must be able to manage (and preview) their own course's content at any
// time, including before it opens or after it closes to students.
function canManage(instructorId, course) {
  if (!instructorId || !course) return false;
  return course.trainerId === instructorId;
}

module.exports = { isEnrolled, canView, canDownload, canManage, courseAccessWindowStatus };

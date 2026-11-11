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
const { sanitizeLessonHtml } = require("./../lib/lms-sanitize");
const { LMS_CONTENT_DIR } = require("./../lib/lms-content-storage");

const lmsCfg = discounts.loadConfig().security;

// One allowlist per contentType this route accepts uploads for -- Section
// 13's "validate MIME type... validate extension" applies to all of
// VIDEO/PDF/DOCUMENT/PRESENTATION, not just video, so this is one shared
// table rather than four near-duplicate multer configs.
const ALLOWED_MIME_BY_TYPE = {
  VIDEO: { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" },
  PDF: { "application/pdf": ".pdf" },
  DOCUMENT: {
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  },
  PRESENTATION: {
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  },
};

const contentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LMS_CONTENT_DIR),
    // The stored filename is a generated ID, never the client-supplied
    // originalname -- Section 13's "do not trust IDs/names supplied by the
    // client" applies just as much to a filename used as a path component
    // as it does to a database ID. The real name is kept separately in
    // lms_content_assets.originalFilename for display/download purposes.
    filename: (req, file, cb) => {
      const contentType = req.body.contentType || (req.lmsLesson && req.lmsLesson.contentType);
      const ext = (ALLOWED_MIME_BY_TYPE[contentType] || {})[file.mimetype] || path.extname(file.originalname);
      cb(null, `${newId("lmsasset")}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    // On create, contentType comes from the submitted form field. On edit,
    // the form deliberately doesn't resend it (content type is fixed once
    // a lesson exists -- see the read-only note in the course-builder UI),
    // so it's read from the lesson loadOwnedLesson already attached to
    // the request instead. Without this fallback, replacing a lesson's
    // file on edit would always fail: contentType would be undefined,
    // matching no entry in the allowlist -- found by actually testing a
    // file replacement, not by reading the filter logic.
    const contentType = req.body.contentType || (req.lmsLesson && req.lmsLesson.contentType);
    const allowed = ALLOWED_MIME_BY_TYPE[contentType];
    if (!allowed || !allowed[file.mimetype]) {
      return cb(new Error(`File type not allowed for a ${contentType || "this"} lesson.`));
    }
    cb(null, true);
  },
  limits: { fileSize: Math.max(lmsCfg.LMS_VIDEO_MAX_FILE_SIZE_MB, lmsCfg.LMS_DOCUMENT_MAX_FILE_SIZE_MB) * 1024 * 1024 },
});

router.use("/trainer/lms", security.requireSameOrigin);
// Scoped to /trainer/lms specifically, not bare router.use(auth.requireInstructor)
// -- an unscoped router.use() runs for every request that reaches this
// router at all, since it's mounted at "/" in app.js alongside
// lms-student.js. An unscoped instructor check here would intercept and
// redirect *student* routes too, before they ever got a chance to match
// in lms-student.js. Found by actually testing student access, not by
// reading the code -- a student login + course-access attempt was
// silently redirected to /trainer/login instead of reaching the intended
// route at all.
router.use("/trainer/lms", auth.requireInstructor);

// Every route below operates on a specific course. This one middleware
// loads it and checks ownership once, rather than repeating
// "find the course, then check trainerId" in every handler -- Section 94's
// "centralized authorization... avoid duplicated permission logic".
// Mounted per-route (not router.use()) because a few routes key off a
// moduleId or lessonId instead of a courseId directly.
function loadOwnedCourse(req, res, next) {
  const course = store.findOne("courses", (c) => c.id === req.params.courseId);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  if (!lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsCourse = course;
  next();
}

// Same ownership check, but starting from a moduleId/lessonId rather than
// a courseId -- resolves up to the owning course first.
function loadOwnedModule(req, res, next) {
  const mod = store.findOne("lms_modules", (m) => m.id === req.params.moduleId);
  if (!mod) return res.status(404).render("404", { title: "Module not found" });
  const course = store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsModule = mod;
  req.lmsCourse = course;
  next();
}

function loadOwnedLesson(req, res, next) {
  const lesson = store.findOne("lms_lessons", (l) => l.id === req.params.lessonId);
  if (!lesson) return res.status(404).render("404", { title: "Lesson not found" });
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsLesson = lesson;
  req.lmsModule = mod;
  req.lmsCourse = course;
  next();
}

// Shared by the lesson create and edit routes below. HTML form submission
// collapses a single checked checkbox to a bare string rather than a
// one-element array (only 2+ checked values arrive as an array), so both
// shapes are normalized here. Returns null (not []) when nothing was
// checked, since that's the "common to every mode" state every lesson
// created before this feature existed already has -- an empty array
// would read ambiguously as "applies to no mode at all."
function normalizeApplicableModes(raw) {
  const modes = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const valid = modes.filter((m) => ["LIVE_ONLINE", "RECORDED", "HYBRID"].includes(m));
  return valid.length > 0 ? valid : null;
}

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

// Dashboard: every course this instructor is the assigned trainer for,
// with a rollup of how much LMS content exists for each. Empty state
// (Section 6: "Do not create mock analytics. If there is no data, show
// proper empty states.") when the instructor has no courses at all, and
// a distinct, honest "0 modules yet" state per-course rather than a fake
// number.
router.get("/trainer/lms", (req, res) => {
  const instructor = store.findOne("instructors", (i) => i.id === req.session.instructorId);
  const myCourses = store.readAll("courses").filter((c) => c.trainerId === req.session.instructorId);
  const courseSummaries = myCourses.map((c) => {
    const modules = store.readAll("lms_modules").filter((m) => m.courseId === c.id);
    const moduleIds = new Set(modules.map((m) => m.id));
    const lessons = store.readAll("lms_lessons").filter((l) => moduleIds.has(l.moduleId));
    return {
      course: c,
      moduleCount: modules.length,
      lessonCount: lessons.length,
      publishedLessonCount: lessons.filter((l) => l.isPublished).length,
    };
  });
  res.render("lms/teacher-dashboard", {
    title: "My LMS Courses — Baseline Skills",
    instructor,
    courseSummaries,
  });
});

router.get("/trainer/lms/courses/:courseId", loadOwnedCourse, (req, res) => {
  const instructor = store.findOne("instructors", (i) => i.id === req.session.instructorId);
  res.render("lms/teacher-course-builder", {
    title: `${req.lmsCourse.title} — Course Builder`,
    instructor,
    course: req.lmsCourse,
    modules: modulesWithLessons(req.lmsCourse.id),
  });
});

router.post("/trainer/lms/courses/:courseId/delivery-mode", loadOwnedCourse, (req, res) => {
  // A course's LMS content can now be configured for more than one mode
  // at once (checkboxes), not just a single choice -- req.body.lmsDeliveryModes
  // arrives as an array when 2+ boxes are checked, but as a bare string
  // when exactly one is (a quirk of how HTML form submission collapses a
  // single same-named field), so both shapes are normalized to an array
  // here rather than assuming the array shape.
  const raw = req.body.lmsDeliveryModes;
  const modes = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const validModes = modes.filter((m) => ["LIVE_ONLINE", "RECORDED", "HYBRID"].includes(m));
  if (validModes.length === 0) {
    return res.status(400).send("Choose at least one delivery mode.");
  }
  store.update("courses", req.lmsCourse.id, { lmsDeliveryModes: validModes, lmsDeliveryMode: validModes[0] });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

// Section 63: "end date >= start date" is an explicit named validation
// example -- checked here even though a backwards window isn't a security
// issue by itself, since a teacher who transposed the two fields deserves
// a clear rejection rather than a course that's silently never
// accessible (start after end means courseAccessWindowStatus() can never
// return "open").
router.post("/trainer/lms/courses/:courseId/access-window", loadOwnedCourse, (req, res) => {
  const startDate = (req.body.lmsAccessStartDate || "").trim() || null;
  const endDate = (req.body.lmsAccessEndDate || "").trim() || null;
  if (startDate && isNaN(new Date(startDate).getTime())) return res.status(400).send("Invalid start date.");
  if (endDate && isNaN(new Date(endDate).getTime())) return res.status(400).send("Invalid end date.");
  if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
    return res.status(400).send("End date must be on or after the start date.");
  }
  store.update("courses", req.lmsCourse.id, { lmsAccessStartDate: startDate, lmsAccessEndDate: endDate });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

router.post("/trainer/lms/courses/:courseId/modules", loadOwnedCourse, (req, res) => {
  const title = (req.body.title || "").trim();
  if (!title) return res.status(400).send("Module title is required.");
  const existing = store.readAll("lms_modules").filter((m) => m.courseId === req.lmsCourse.id);
  const maxPosition = existing.reduce((max, m) => Math.max(max, m.position), 0);
  store.insert("lms_modules", {
    courseId: req.lmsCourse.id,
    title,
    description: (req.body.description || "").trim(),
    position: maxPosition + 1,
    createdAt: new Date().toISOString(),
  });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

router.post("/trainer/lms/modules/:moduleId/edit", loadOwnedModule, (req, res) => {
  const title = (req.body.title || "").trim();
  if (!title) return res.status(400).send("Module title is required.");
  store.update("lms_modules", req.lmsModule.id, {
    title, description: (req.body.description || "").trim(), updatedAt: new Date().toISOString(),
  });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

router.post("/trainer/lms/modules/:moduleId/delete", loadOwnedModule, (req, res) => {
  // The ON DELETE CASCADE foreign keys correctly remove the lms_lessons
  // and lms_content_assets *rows* when a module is deleted, but SQLite
  // has no idea those rows pointed at real files on disk -- cascading a
  // database row is not the same as cleaning up the storage object it
  // referenced. Found by actually deleting a module with real uploaded
  // files and checking the disk afterward, not by reading the cascade
  // constraint and assuming it was enough. Every lesson's asset must be
  // deleted from disk *before* the cascade removes the row that's the
  // only record of which file that was.
  const lessonsInModule = store.readAll("lms_lessons").filter((l) => l.moduleId === req.lmsModule.id);
  lessonsInModule.forEach((lesson) => {
    const asset = store.findOne("lms_content_assets", (a) => a.lessonId === lesson.id);
    if (asset) {
      const assetPath = path.join(LMS_CONTENT_DIR, asset.storageKey);
      if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
    }
  });
  store.remove("lms_modules", req.lmsModule.id);
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

// Lesson content type is fixed to RICH_TEXT for this phase -- the schema
// (contentType CHECK column) already supports the full set from Section
// 11, but VIDEO/PDF/DOCUMENT/PRESENTATION/QUIZ/ASSIGNMENT each need real
// upload/scoring/grading machinery this phase doesn't build. Creating a
// lesson row that claims one of those types with no actual content behind
// it would be exactly the "pages render, mock data" failure Section 99
// explicitly forbids.
const VALID_CONTENT_TYPES = ["RICH_TEXT", "VIDEO", "PDF", "DOCUMENT", "PRESENTATION", "QUIZ", "ASSIGNMENT"];
const FILE_REQUIRED_TYPES = ["VIDEO", "PDF", "DOCUMENT", "PRESENTATION"];

function saveContentAsset(lessonId, file) {
  // Replaces any existing asset for this lesson (one asset per lesson) --
  // the old file is deleted from disk too, not just its database row,
  // so a lesson re-uploaded five times doesn't silently accumulate four
  // orphaned files on the persistent disk. Section 13's "do not leave
  // orphaned storage objects" applies to replacement, not just failed
  // uploads.
  const old = store.findOne("lms_content_assets", (a) => a.lessonId === lessonId);
  if (old) {
    const oldPath = path.join(LMS_CONTENT_DIR, old.storageKey);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    store.remove("lms_content_assets", old.id);
  }
  store.insert("lms_content_assets", {
    lessonId, storageKey: file.filename, originalFilename: file.originalname,
    mimeType: file.mimetype, sizeBytes: file.size, createdAt: new Date().toISOString(),
  });
}

router.post("/trainer/lms/modules/:moduleId/lessons", loadOwnedModule, (req, res, next) => {
  contentUpload.single("contentFile")(req, res, (err) => {
    if (err) return res.status(400).send(err.message);
    const title = (req.body.title || "").trim();
    const contentType = req.body.contentType;
    if (!title) return res.status(400).send("Lesson title is required.");
    if (!VALID_CONTENT_TYPES.includes(contentType)) return res.status(400).send("Invalid content type.");
    if (FILE_REQUIRED_TYPES.includes(contentType) && !req.file) {
      return res.status(400).send(`A file is required for a ${contentType} lesson.`);
    }
    const existing = store.readAll("lms_lessons").filter((l) => l.moduleId === req.lmsModule.id);
    const maxPosition = existing.reduce((max, l) => Math.max(max, l.position), 0);
    const lesson = store.insert("lms_lessons", {
      moduleId: req.lmsModule.id,
      title,
      description: (req.body.description || "").trim(),
      contentType,
      bodyHtml: contentType === "RICH_TEXT" ? sanitizeLessonHtml(req.body.bodyHtml) : null,
      position: maxPosition + 1,
      isPublished: false,
      previewEnabled: false,
      downloadAllowed: false,
      applicableModes: normalizeApplicableModes(req.body.applicableModes),
      createdAt: new Date().toISOString(),
    });
    if (req.file) saveContentAsset(lesson.id, req.file);
    // A QUIZ lesson always gets its lms_quizzes row created immediately,
    // with sane defaults (1 attempt, 70% pass) -- there's no meaningful
    // state for a QUIZ lesson to be in without one, unlike a video lesson
    // which can exist briefly with no asset. The teacher lands straight on
    // the quiz builder to configure it and add questions.
    if (contentType === "QUIZ") {
      store.insert("lms_quizzes", {
        lessonId: lesson.id, timeLimitSeconds: null, maxAttempts: 1,
        passPercentage: 70, negativeMarkingEnabled: false, showCorrectAnswers: true,
        createdAt: new Date().toISOString(),
      });
      return res.redirect(`/trainer/lms/lessons/${lesson.id}/quiz`);
    }
    // Same reasoning as QUIZ above -- an ASSIGNMENT lesson with no
    // lms_assignments row has no meaningful state to be in at all, so one
    // is always created immediately with sane defaults, and the teacher
    // lands straight on its settings to fill in instructions/deadline.
    if (contentType === "ASSIGNMENT") {
      store.insert("lms_assignments", {
        lessonId: lesson.id, instructions: null, deadline: null, maxMarks: 100,
        allowedFileTypes: ".pdf,.doc,.docx", maxFileSizeMB: 20, allowResubmission: true,
        createdAt: new Date().toISOString(),
      });
      return res.redirect(`/trainer/lms/lessons/${lesson.id}/assignment`);
    }
    res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
  });
});

router.post("/trainer/lms/lessons/:lessonId/edit", loadOwnedLesson, (req, res) => {
  contentUpload.single("contentFile")(req, res, (err) => {
    if (err) return res.status(400).send(err.message);
    const title = (req.body.title || "").trim();
    if (!title) return res.status(400).send("Lesson title is required.");
    store.update("lms_lessons", req.lmsLesson.id, {
      title,
      description: (req.body.description || "").trim(),
      bodyHtml: req.lmsLesson.contentType === "RICH_TEXT" ? sanitizeLessonHtml(req.body.bodyHtml) : req.lmsLesson.bodyHtml,
      applicableModes: normalizeApplicableModes(req.body.applicableModes),
      updatedAt: new Date().toISOString(),
    });
    if (req.file) saveContentAsset(req.lmsLesson.id, req.file);
    res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
  });
});

router.post("/trainer/lms/lessons/:lessonId/delete", loadOwnedLesson, (req, res) => {
  const asset = store.findOne("lms_content_assets", (a) => a.lessonId === req.lmsLesson.id);
  if (asset) {
    const assetPath = path.join(LMS_CONTENT_DIR, asset.storageKey);
    if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
  }
  store.remove("lms_lessons", req.lmsLesson.id);
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

router.post("/trainer/lms/lessons/:lessonId/publish", loadOwnedLesson, (req, res) => {
  store.update("lms_lessons", req.lmsLesson.id, { isPublished: !req.lmsLesson.isPublished });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

router.post("/trainer/lms/lessons/:lessonId/preview", loadOwnedLesson, (req, res) => {
  store.update("lms_lessons", req.lmsLesson.id, { previewEnabled: !req.lmsLesson.previewEnabled });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

router.post("/trainer/lms/lessons/:lessonId/download-toggle", loadOwnedLesson, (req, res) => {
  store.update("lms_lessons", req.lmsLesson.id, { downloadAllowed: !req.lmsLesson.downloadAllowed });
  res.redirect(`/trainer/lms/courses/${req.lmsCourse.id}`);
});

// Reordering: accepts an ordered array of IDs (either module IDs within a
// course, or lesson IDs within a module) and re-sequences their position
// field to clean integers matching that order. The frontend drag-and-drop
// only ever determines final order, never raw position numbers directly
// -- Section 10's "do not rely on DOM order alone / avoid fragile
// ordering based on array indexes in the frontend" is satisfied by the
// server owning the actual numbering, with the client only saying "this
// is the new order" via IDs.
router.post("/trainer/lms/modules/:moduleId/lessons/reorder", loadOwnedModule, (req, res) => {
  const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [];
  const lessons = store.readAll("lms_lessons").filter((l) => l.moduleId === req.lmsModule.id);
  const lessonIds = new Set(lessons.map((l) => l.id));
  // Every ID must genuinely belong to this module -- never trust client-
  // supplied IDs (Section 63) enough to let a reorder request silently
  // move a lesson into a different module's ordering.
  if (orderedIds.length !== lessons.length || !orderedIds.every((id) => lessonIds.has(id))) {
    return res.status(400).json({ error: "Reorder list doesn't match this module's lessons." });
  }
  orderedIds.forEach((id, index) => store.update("lms_lessons", id, { position: index + 1 }));
  res.json({ ok: true });
});

router.post("/trainer/lms/courses/:courseId/modules/reorder", loadOwnedCourse, (req, res) => {
  const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [];
  const modules = store.readAll("lms_modules").filter((m) => m.courseId === req.lmsCourse.id);
  const moduleIds = new Set(modules.map((m) => m.id));
  if (orderedIds.length !== modules.length || !orderedIds.every((id) => moduleIds.has(id))) {
    return res.status(400).json({ error: "Reorder list doesn't match this course's modules." });
  }
  orderedIds.forEach((id, index) => store.update("lms_modules", id, { position: index + 1 }));
  res.json({ ok: true });
});

// Teacher preview: renders the exact same lesson-viewing template the
// student player uses, but bypasses the enrollment check specifically
// because the requester is verified as this course's own instructor --
// Section 18's "must not accidentally grant enrolled-student permissions"
// is about student-side access control, not about blocking the owning
// teacher from seeing their own draft content.
router.get("/trainer/lms/courses/:courseId/preview", loadOwnedCourse, (req, res) => {
  res.render("lms/course-player", {
    title: `Preview — ${req.lmsCourse.title}`,
    course: req.lmsCourse,
    modules: modulesWithLessons(req.lmsCourse.id),
    isTeacherPreview: true,
    activeLesson: null,
    completedLessonIds: new Set(),
  });
});

router.get("/trainer/lms/courses/:courseId/preview/lessons/:lessonId", loadOwnedCourse, (req, res) => {
  const modules = modulesWithLessons(req.lmsCourse.id);
  const lesson = modules.flatMap((m) => m.lessons).find((l) => l.id === req.params.lessonId);
  if (!lesson) return res.status(404).render("404", { title: "Lesson not found" });
  res.render("lms/course-player", {
    title: `Preview — ${req.lmsCourse.title}`,
    course: req.lmsCourse,
    modules,
    isTeacherPreview: true,
    activeLesson: lesson,
    completedLessonIds: new Set(),
  });
});

// ==================== Quiz builder ====================
const quizLib = require("./../lib/lms-quiz");

// Same ownership-resolution pattern as loadOwnedLesson/loadOwnedModule
// above, starting from a quizId or questionId instead -- resolves up to
// the owning course so the exact same canManage() check applies no matter
// which level of the quiz hierarchy the URL names.
function loadOwnedQuiz(req, res, next) {
  const quiz = store.findOne("lms_quizzes", (q) => q.id === req.params.quizId);
  if (!quiz) return res.status(404).render("404", { title: "Quiz not found" });
  const lesson = store.findOne("lms_lessons", (l) => l.id === quiz.lessonId);
  const mod = lesson && store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsQuiz = quiz; req.lmsLesson = lesson; req.lmsCourse = course;
  next();
}

function loadOwnedQuestion(req, res, next) {
  const question = store.findOne("lms_questions", (q) => q.id === req.params.questionId);
  if (!question) return res.status(404).render("404", { title: "Question not found" });
  const quiz = store.findOne("lms_quizzes", (q) => q.id === question.quizId);
  const lesson = quiz && store.findOne("lms_lessons", (l) => l.id === quiz.lessonId);
  const mod = lesson && store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsQuestion = question; req.lmsQuiz = quiz; req.lmsLesson = lesson; req.lmsCourse = course;
  next();
}

function loadOwnedCaseStudy(req, res, next) {
  const caseStudy = store.findOne("lms_case_studies", (c) => c.id === req.params.caseStudyId);
  if (!caseStudy) return res.status(404).render("404", { title: "Case study not found" });
  const quiz = store.findOne("lms_quizzes", (q) => q.id === caseStudy.quizId);
  const lesson = quiz && store.findOne("lms_lessons", (l) => l.id === quiz.lessonId);
  const mod = lesson && store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsCaseStudy = caseStudy; req.lmsQuiz = quiz; req.lmsLesson = lesson; req.lmsCourse = course;
  next();
}

function quizWithDetails(quizId) {
  const caseStudies = store.readAll("lms_case_studies").filter((c) => c.quizId === quizId).sort((a, b) => a.position - b.position);
  const questions = store.readAll("lms_questions").filter((q) => q.quizId === quizId).sort((a, b) => a.position - b.position)
    .map((q) => ({ ...q, options: store.readAll("lms_question_options").filter((o) => o.questionId === q.id).sort((a, b) => a.position - b.position) }));
  return { caseStudies, questions };
}

router.get("/trainer/lms/lessons/:lessonId/quiz", loadOwnedLesson, (req, res) => {
  const quiz = store.findOne("lms_quizzes", (q) => q.lessonId === req.lmsLesson.id);
  if (!quiz) return res.status(404).render("404", { title: "Quiz not found" });
  const { caseStudies, questions } = quizWithDetails(quiz.id);
  res.render("lms/teacher-quiz-builder", {
    title: `Quiz — ${req.lmsLesson.title}`,
    course: req.lmsCourse, lesson: req.lmsLesson, quiz, caseStudies, questions,
  });
});

// Section 21: all the named quiz settings, validated together. Section 63's
// "end date >= start date" spirit applied here too: numeric fields must
// actually be sane numbers, not just present, since a negative time limit
// or a >100% pass threshold would silently make the quiz un-passable or
// meaningless rather than erroring clearly at save time.
router.post("/trainer/lms/quizzes/:quizId/settings", loadOwnedQuiz, (req, res) => {
  const timeLimitMinutes = req.body.timeLimitMinutes === "" ? null : Number(req.body.timeLimitMinutes);
  const maxAttempts = Number(req.body.maxAttempts);
  const passPercentage = Number(req.body.passPercentage);
  if (timeLimitMinutes !== null && (!Number.isFinite(timeLimitMinutes) || timeLimitMinutes <= 0)) {
    return res.status(400).send("Time limit must be a positive number of minutes, or blank for no limit.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return res.status(400).send("Max attempts must be a whole number of at least 1.");
  if (!Number.isFinite(passPercentage) || passPercentage < 0 || passPercentage > 100) {
    return res.status(400).send("Pass percentage must be between 0 and 100.");
  }
  store.update("lms_quizzes", req.lmsQuiz.id, {
    timeLimitSeconds: timeLimitMinutes !== null ? Math.round(timeLimitMinutes * 60) : null,
    maxAttempts, passPercentage,
    negativeMarkingEnabled: req.body.negativeMarkingEnabled !== undefined,
    showCorrectAnswers: req.body.showCorrectAnswers !== undefined,
    updatedAt: new Date().toISOString(),
  });
  res.redirect(`/trainer/lms/lessons/${req.lmsLesson.id}/quiz`);
});

router.post("/trainer/lms/quizzes/:quizId/case-studies", loadOwnedQuiz, (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).send("Case study content is required.");
  const existing = store.readAll("lms_case_studies").filter((c) => c.quizId === req.lmsQuiz.id);
  const maxPosition = existing.reduce((max, c) => Math.max(max, c.position), 0);
  store.insert("lms_case_studies", {
    quizId: req.lmsQuiz.id, title: (req.body.title || "").trim(),
    content: sanitizeLessonHtml(content), position: maxPosition + 1,
  });
  res.redirect(`/trainer/lms/lessons/${req.lmsLesson.id}/quiz`);
});

router.post("/trainer/lms/case-studies/:caseStudyId/delete", loadOwnedCaseStudy, (req, res) => {
  // ON DELETE SET NULL on lms_questions.caseStudyId means questions that
  // referenced this case study survive as ordinary standalone questions
  // rather than being deleted with it -- a case study is a grouping, not
  // an owner, so removing the grouping shouldn't take its questions with
  // it (Section 20 describes questions as *referencing* the case study,
  // language that implies exactly this relationship).
  store.remove("lms_case_studies", req.lmsCaseStudy.id);
  res.redirect(`/trainer/lms/lessons/${req.lmsLesson.id}/quiz`);
});

const QUESTION_TYPES = ["MCQ", "MULTI_SELECT", "TRUE_FALSE", "SHORT_ANSWER"];
const MAX_OPTION_SLOTS = 6;

function parseOptionsFromBody(body, questionType) {
  if (questionType === "SHORT_ANSWER") return [];
  if (questionType === "TRUE_FALSE") {
    return [
      { optionText: "True", isCorrect: body.trueFalseAnswer === "true" },
      { optionText: "False", isCorrect: body.trueFalseAnswer === "false" },
    ];
  }
  const options = [];
  for (let i = 0; i < MAX_OPTION_SLOTS; i++) {
    const text = (body[`optionText${i}`] || "").trim();
    if (!text) continue; // empty slots are simply not saved, not an error
    const isCorrect = questionType === "MCQ"
      ? body.correctOption === String(i)
      : body[`optionCorrect${i}`] !== undefined;
    options.push({ optionText: text, isCorrect });
  }
  return options;
}

router.post("/trainer/lms/quizzes/:quizId/questions", loadOwnedQuiz, (req, res) => {
  const questionText = (req.body.questionText || "").trim();
  const questionType = req.body.questionType;
  if (!questionText) return res.status(400).send("Question text is required.");
  if (!QUESTION_TYPES.includes(questionType)) return res.status(400).send("Invalid question type.");
  const options = parseOptionsFromBody(req.body, questionType);
  if (questionType !== "SHORT_ANSWER") {
    if (options.length < 2) return res.status(400).send("At least 2 options are required.");
    if (!options.some((o) => o.isCorrect)) return res.status(400).send("At least one option must be marked correct.");
  }
  const caseStudyId = (req.body.caseStudyId || "").trim() || null;
  if (caseStudyId && !store.findOne("lms_case_studies", (c) => c.id === caseStudyId && c.quizId === req.lmsQuiz.id)) {
    return res.status(400).send("That case study doesn't belong to this quiz.");
  }
  const marks = Number(req.body.marks);
  const negativeMarks = Number(req.body.negativeMarks) || 0;
  if (!Number.isFinite(marks) || marks <= 0) return res.status(400).send("Marks must be a positive number.");
  if (negativeMarks < 0) return res.status(400).send("Negative marks can't itself be negative.");

  const existing = store.readAll("lms_questions").filter((q) => q.quizId === req.lmsQuiz.id);
  const maxPosition = existing.reduce((max, q) => Math.max(max, q.position), 0);
  const question = store.insert("lms_questions", {
    quizId: req.lmsQuiz.id, caseStudyId, questionType,
    questionText: sanitizeLessonHtml(questionText), explanation: sanitizeLessonHtml((req.body.explanation || "").trim()),
    marks, negativeMarks, position: maxPosition + 1, createdAt: new Date().toISOString(),
  });
  options.forEach((o, i) => store.insert("lms_question_options", { questionId: question.id, optionText: o.optionText, isCorrect: o.isCorrect, position: i }));
  res.redirect(`/trainer/lms/lessons/${req.lmsLesson.id}/quiz`);
});

router.post("/trainer/lms/questions/:questionId/delete", loadOwnedQuestion, (req, res) => {
  store.remove("lms_questions", req.lmsQuestion.id);
  res.redirect(`/trainer/lms/lessons/${req.lmsLesson.id}/quiz`);
});

router.post("/trainer/lms/quizzes/:quizId/questions/reorder", loadOwnedQuiz, (req, res) => {
  const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [];
  const questions = store.readAll("lms_questions").filter((q) => q.quizId === req.lmsQuiz.id);
  const questionIds = new Set(questions.map((q) => q.id));
  if (orderedIds.length !== questions.length || !orderedIds.every((id) => questionIds.has(id))) {
    return res.status(400).json({ error: "Reorder list doesn't match this quiz's questions." });
  }
  orderedIds.forEach((id, index) => store.update("lms_questions", id, { position: index + 1 }));
  res.json({ ok: true });
});

// Section 25/50: manual grading for SHORT_ANSWER questions. Lists every
// answer across every attempt at this quiz that's still ungraded
// (marksAwarded == null), grouped loosely by showing the learner and
// question together -- a teacher grading a batch wants to see what's
// outstanding, not hunt through individual attempts one at a time.
router.get("/trainer/lms/quizzes/:quizId/grading", loadOwnedQuiz, (req, res) => {
  const questionIds = new Set(
    store.readAll("lms_questions").filter((q) => q.quizId === req.lmsQuiz.id && q.questionType === "SHORT_ANSWER").map((q) => q.id)
  );
  const attempts = store.readAll("lms_quiz_attempts").filter((a) => a.quizId === req.lmsQuiz.id);
  const attemptIds = new Set(attempts.map((a) => a.id));
  const pendingAnswers = store.readAll("lms_quiz_answers")
    .filter((a) => attemptIds.has(a.attemptId) && questionIds.has(a.questionId) && a.marksAwarded == null)
    .map((a) => {
      const attempt = attempts.find((at) => at.id === a.attemptId);
      const learner = store.findOne("learners", (l) => l.id === attempt.learnerId);
      const question = store.findOne("lms_questions", (q) => q.id === a.questionId);
      return { answer: a, attempt, learner, question };
    });
  res.render("lms/teacher-quiz-grading", {
    title: `Grade — ${req.lmsLesson.title}`,
    course: req.lmsCourse, lesson: req.lmsLesson, quiz: req.lmsQuiz, pendingAnswers,
  });
});

router.post("/trainer/lms/answers/:answerId/grade", (req, res) => {
  const answer = store.findOne("lms_quiz_answers", (a) => a.id === req.params.answerId);
  if (!answer) return res.status(404).send("Answer not found.");
  const question = store.findOne("lms_questions", (q) => q.id === answer.questionId);
  const quiz = store.findOne("lms_quizzes", (q) => q.id === question.quizId);
  const lesson = store.findOne("lms_lessons", (l) => l.id === quiz.lessonId);
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = store.findOne("courses", (c) => c.id === mod.courseId);
  if (!lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  const marksAwarded = Number(req.body.marksAwarded);
  if (!Number.isFinite(marksAwarded) || marksAwarded < 0 || marksAwarded > question.marks) {
    return res.status(400).send(`Marks must be between 0 and ${question.marks}.`);
  }
  store.update("lms_quiz_answers", answer.id, {
    marksAwarded, isCorrect: marksAwarded > 0,
    gradedAt: new Date().toISOString(), gradedBy: req.session.instructorId,
  });
  // Section 50/52: the student's result updates as soon as grading
  // happens, not on some later batch job -- re-scoring the whole attempt
  // here means if this was the last outstanding short-answer question,
  // the attempt flips from PENDING_MANUAL_GRADING to a real pass/fail
  // immediately.
  quizLib.scoreAttempt(answer.attemptId);
  res.redirect(`/trainer/lms/quizzes/${quiz.id}/grading`);
});

// ==================== Assignments ====================
function loadOwnedAssignment(req, res, next) {
  const assignment = store.findOne("lms_assignments", (a) => a.id === req.params.assignmentId);
  if (!assignment) return res.status(404).render("404", { title: "Assignment not found" });
  const lesson = store.findOne("lms_lessons", (l) => l.id === assignment.lessonId);
  const mod = lesson && store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course || !lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  req.lmsAssignment = assignment; req.lmsLesson = lesson; req.lmsCourse = course;
  next();
}

router.get("/trainer/lms/lessons/:lessonId/assignment", loadOwnedLesson, (req, res) => {
  const assignment = store.findOne("lms_assignments", (a) => a.lessonId === req.lmsLesson.id);
  if (!assignment) return res.status(404).render("404", { title: "Assignment not found" });
  const submissions = store.readAll("lms_assignment_submissions")
    .filter((s) => s.assignmentId === assignment.id)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .map((s) => ({ ...s, learner: store.findOne("learners", (l) => l.id === s.learnerId) }));
  res.render("lms/teacher-assignment-builder", {
    title: `Assignment — ${req.lmsLesson.title}`,
    course: req.lmsCourse, lesson: req.lmsLesson, assignment, submissions,
  });
});

// Section 63: deadline must actually be a valid date if provided at all;
// maxMarks/maxFileSizeMB sane positive numbers, same spirit as the quiz
// settings validation above.
router.post("/trainer/lms/assignments/:assignmentId/settings", loadOwnedAssignment, (req, res) => {
  const deadline = (req.body.deadline || "").trim() || null;
  if (deadline && isNaN(new Date(deadline).getTime())) return res.status(400).send("Invalid deadline.");
  const maxMarks = Number(req.body.maxMarks);
  const maxFileSizeMB = Number(req.body.maxFileSizeMB);
  if (!Number.isFinite(maxMarks) || maxMarks <= 0) return res.status(400).send("Max marks must be a positive number.");
  if (!Number.isInteger(maxFileSizeMB) || maxFileSizeMB <= 0) return res.status(400).send("Max file size must be a positive whole number of MB.");
  const allowedFileTypes = (req.body.allowedFileTypes || "").trim() || ".pdf,.doc,.docx";
  store.update("lms_assignments", req.lmsAssignment.id, {
    instructions: sanitizeLessonHtml((req.body.instructions || "").trim()),
    deadline, maxMarks, maxFileSizeMB, allowedFileTypes,
    allowResubmission: req.body.allowResubmission !== undefined,
    updatedAt: new Date().toISOString(),
  });
  res.redirect(`/trainer/lms/lessons/${req.lmsLesson.id}/assignment`);
});

router.post("/trainer/lms/submissions/:submissionId/grade", (req, res) => {
  const submission = store.findOne("lms_assignment_submissions", (s) => s.id === req.params.submissionId);
  if (!submission) return res.status(404).send("Submission not found.");
  const assignment = store.findOne("lms_assignments", (a) => a.id === submission.assignmentId);
  const lesson = store.findOne("lms_lessons", (l) => l.id === assignment.lessonId);
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = store.findOne("courses", (c) => c.id === mod.courseId);
  if (!lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  const marks = Number(req.body.marks);
  if (!Number.isFinite(marks) || marks < 0 || marks > assignment.maxMarks) {
    return res.status(400).send(`Marks must be between 0 and ${assignment.maxMarks}.`);
  }
  store.update("lms_assignment_submissions", submission.id, {
    marks, feedback: (req.body.feedback || "").trim(),
    gradedAt: new Date().toISOString(), gradedBy: req.session.instructorId,
  });
  res.redirect(`/trainer/lms/lessons/${lesson.id}/assignment`);
});

router.get("/trainer/lms/submissions/:submissionId/download", (req, res) => {
  const submission = store.findOne("lms_assignment_submissions", (s) => s.id === req.params.submissionId);
  if (!submission) return res.status(404).render("404", { title: "Submission not found" });
  const assignment = store.findOne("lms_assignments", (a) => a.id === submission.assignmentId);
  const lesson = store.findOne("lms_lessons", (l) => l.id === assignment.lessonId);
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = store.findOne("courses", (c) => c.id === mod.courseId);
  if (!lmsAccess.canManage(req.session.instructorId, course)) {
    return res.status(403).send("You don't have access to manage this course.");
  }
  const { LMS_SUBMISSION_DIR } = require("./../lib/lms-submission-storage");
  const filePath = path.join(LMS_SUBMISSION_DIR, submission.storageKey);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: "Submission file not found" });
  res.download(filePath, submission.originalFilename || submission.storageKey);
});

// Section 56: real, computed course + per-student analytics -- see
// lib/lms-analytics.js for how every number here is actually derived.
router.get("/trainer/lms/courses/:courseId/analytics", loadOwnedCourse, (req, res) => {
  const analyticsLib = require("./../lib/lms-analytics");
  const analytics = analyticsLib.courseAnalytics(req.lmsCourse.id);
  res.render("lms/teacher-course-analytics", {
    title: `Analytics — ${req.lmsCourse.title}`,
    course: req.lmsCourse, analytics,
  });
});

module.exports = router;

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const store = require("./../lib/db");
const lmsAccess = require("./../lib/lms-content-access");
const { LMS_CONTENT_DIR } = require("./../lib/lms-content-storage");

// The one place every LMS file (video/PDF/document/presentation) is
// actually served from -- Section 32's preferred flow (auth -> enrollment
// -> date check -> permission check -> short-lived access -> serve)
// implemented as a real per-request check rather than a signed URL, since
// this app has no CDN/signed-URL infrastructure to issue those from.
// Every request re-checks LmsContentAccessService fresh; nothing here
// trusts an asset ID's obscurity, matching Section 32's explicit
// "do not rely on obscurity of asset IDs".
function loadAssetContext(req) {
  const asset = store.findOne("lms_content_assets", (a) => a.id === req.params.assetId);
  if (!asset) return null;
  const lesson = store.findOne("lms_lessons", (l) => l.id === asset.lessonId);
  if (!lesson) return null;
  const mod = store.findOne("lms_modules", (m) => m.id === lesson.moduleId);
  const course = mod && store.findOne("courses", (c) => c.id === mod.courseId);
  if (!course) return null;
  return { asset, lesson, course };
}

function requesterCanView(req, lesson, course) {
  const instructorId = req.session.instructorId || null;
  if (instructorId && lmsAccess.canManage(instructorId, course)) return true;
  return lmsAccess.canView(req.session.learnerId || null, lesson, course);
}

// View/stream: inline delivery for playing a video or viewing a PDF in the
// browser, never as an attachment -- this is the path both the video
// player and an embedded document viewer use, and it's available whenever
// canView() is true, independent of downloadAllowed.
router.get("/lms/content/:assetId/stream", (req, res) => {
  const ctx = loadAssetContext(req);
  if (!ctx) return res.status(404).render("404", { title: res.locals.t('title_content_not_found') });
  if (!requesterCanView(req, ctx.lesson, ctx.course)) {
    return res.status(403).send("You don't have access to this content.");
  }
  const filePath = path.join(LMS_CONTENT_DIR, ctx.asset.storageKey);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: res.locals.t('title_content_file_not_found') });
  // res.sendFile (via the `send` package Express uses internally) already
  // honors Range request headers for us -- required for HTML5 <video>
  // seeking and seek-ahead to work at all, not just for playback to start.
  // A genuinely out-of-bounds Range header (found while testing malformed
  // headers, not a real player ever sends one) surfaces as a raw
  // RangeNotSatisfiableError that would otherwise fall through to the
  // generic error handler as a bare 500 -- caught here specifically to
  // answer with the actually-correct 416 instead. Any other error still
  // falls through unchanged, so a genuine unexpected failure isn't
  // silently swallowed by this fix.
  res.sendFile(filePath, {
    headers: { "Content-Type": ctx.asset.mimeType, "Content-Disposition": "inline" },
  }, (err) => {
    if (err && err.statusCode === 416) return res.status(416).send("Requested range not satisfiable.");
    if (err && !res.headersSent) return res.status(500).render("500", { title: res.locals.t('err500_title') + " — Baseline Skills" });
  });
});

// Download: Section 16 is explicit that this is an authorization decision,
// not a UI decision -- if downloadAllowed is false, this route must not
// serve the file at all, regardless of whether the requester could
// otherwise stream/view it. There is deliberately no way to reach the
// file bytes through this route without downloadAllowed=true; hiding the
// download button in the UI is not the control, this check is.
router.get("/lms/content/:assetId/download", (req, res) => {
  const ctx = loadAssetContext(req);
  if (!ctx) return res.status(404).render("404", { title: res.locals.t('title_content_not_found') });
  if (!lmsAccess.canDownload(req.session.learnerId || null, ctx.lesson, ctx.course) &&
      !(req.session.instructorId && lmsAccess.canManage(req.session.instructorId, ctx.course))) {
    return res.status(403).send("This content isn't available for download.");
  }
  const filePath = path.join(LMS_CONTENT_DIR, ctx.asset.storageKey);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: res.locals.t('title_content_file_not_found') });
  res.download(filePath, ctx.asset.originalFilename || ctx.asset.storageKey);
});

module.exports = router;

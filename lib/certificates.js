// Certificate and digital badge generation (Master Prompt Sections 17, 18).
// Follows the same storage convention as invoices — outside the app's code
// path, DATA_DIR-relative, so files survive redeploys.
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const store = require("./db");
const { newId } = require("./id");

const CERTIFICATE_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "certificates")
  : path.join(__dirname, "..", "public", "uploads", "certificates");
fs.mkdirSync(CERTIFICATE_DIR, { recursive: true });

const BADGE_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "badges")
  : path.join(__dirname, "..", "public", "uploads", "badges");
fs.mkdirSync(BADGE_DIR, { recursive: true });

// Exact brand palette — kept in sync with the CSS custom properties in
// public/css/style.css rather than approximated, so these PDFs actually
// match the site rather than a close guess at its colors.
const BRAND = {
  navy: "#0F5C56",
  navySoft: "#16847B",
  navyDeep: "#083834",
  gold: "#D98E04",
  goldLight: "#F5B025",
  text: "#1E293B",
  muted: "#64748B",
  line: "#E2E8F0",
  bg: "#F8FAFC",
};

const LOGO_PATH = path.join(__dirname, "..", "public", "img", "certificate-logo.png");
const LOGO_REVERSED_PATH = path.join(__dirname, "..", "public", "img", "wordmark-reversed.png");

function nextCertificateNumber() {
  const year = new Date().getFullYear();
  const existingThisYear = store.readAll("certificates").filter((c) => c.certificateNumber && c.certificateNumber.startsWith(`CERT-${year}-`));
  return `CERT-${year}-${String(existingThisYear.length + 1).padStart(6, "0")}`;
}

function generateCertificatePdf({ certificateNumber, issuedDate, learnerName, courseTitle, verifyUrl, filePath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Matches the badge's dark theme — deep teal background, gold double
    // border, reversed (white) logo, gold for the headline/course title,
    // white for the body text — adapted to this document's wide landscape
    // format rather than the badge's circular emblem layout.
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(BRAND.navyDeep);
    doc.rect(24, 24, doc.page.width - 48, doc.page.height - 48).lineWidth(2).strokeColor(BRAND.goldLight).stroke();
    doc.rect(32, 32, doc.page.width - 64, doc.page.height - 64).lineWidth(0.75).strokeColor(BRAND.navySoft).stroke();

    if (fs.existsSync(LOGO_REVERSED_PATH)) {
      const logoWidth = 200;
      const logoHeight = logoWidth * (246 / 1352);
      doc.image(LOGO_REVERSED_PATH, (doc.page.width - logoWidth) / 2, 127, { width: logoWidth, height: logoHeight });
    }

    doc.fontSize(24).fillColor(BRAND.goldLight).font("Helvetica-Bold").text("Certificate of Completion", 0, 203, { align: "center" });
    doc.moveTo(doc.page.width / 2 - 60, 237).lineTo(doc.page.width / 2 + 60, 237).lineWidth(2).strokeColor(BRAND.gold).stroke();

    doc.font("Helvetica").fontSize(13).fillColor("#C9D6D4").text("This certifies that", 0, 257, { align: "center" });
    doc.font("Helvetica-Bold").fontSize(26).fillColor("#ffffff").text(learnerName, 0, 280, { align: "center" });
    doc.font("Helvetica").fontSize(13).fillColor("#C9D6D4").text("has successfully completed", 0, 323, { align: "center" });
    doc.font("Helvetica-Bold").fontSize(20).fillColor(BRAND.goldLight).text(courseTitle, 0, 346, { align: "center", width: doc.page.width });

    doc.font("Helvetica").fontSize(11).fillColor("#C9D6D4");
    doc.text(`Issued: ${issuedDate}`, 0, 420, { align: "center" });
    doc.text(`Certificate number: ${certificateNumber}`, 0, 437, { align: "center" });
    doc.text(`Verify this certificate: ${verifyUrl}`, 0, 454, { align: "center" });

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// A shareable digital badge — square format, matching the dimensions
// LinkedIn and similar platforms expect for a profile achievement image.
// A distinct visual object from the certificate (a wallet-card-style
// credential, not a shrunken certificate), reusing the same brand palette
// and logo so the two feel like one consistent system.
function generateBadgePdf({ learnerName, courseTitle, issuedDate, certificateNumber, verifyUrl, filePath }) {
  return new Promise((resolve, reject) => {
    const size = 500;
    const doc = new PDFDocument({ size: [size, size], margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Radial-style layered background using the two brand teals, rather
    // than a flat fill, so the badge doesn't read as a plain rectangle.
    doc.rect(0, 0, size, size).fill(BRAND.navyDeep);
    doc.circle(size / 2, size / 2 - 20, size / 2 + 40).fill(BRAND.navy);
    doc.circle(size / 2, size / 2 - 20, size / 2 - 60).lineWidth(3).strokeColor(BRAND.goldLight).stroke();

    if (fs.existsSync(LOGO_REVERSED_PATH)) {
      const logoWidth = 170;
      const logoHeight = logoWidth * (246 / 1352);
      // The reversed (white wordmark) logo variant is designed specifically
      // for dark backgrounds like this badge — no plate needed behind it,
      // unlike the standard dark-text logo used on the certificate.
      doc.image(LOGO_REVERSED_PATH, (size - logoWidth) / 2, 60, { width: logoWidth, height: logoHeight });
    }

    doc.font("Helvetica-Bold").fontSize(15).fillColor("#ffffff").text("CERTIFIED", 0, 145, { align: "center", width: size, characterSpacing: 2 });

    doc.font("Helvetica-Bold").fontSize(19).fillColor(BRAND.goldLight).text(courseTitle, 40, 200, { align: "center", width: size - 80 });

    doc.font("Helvetica").fontSize(13).fillColor("#ffffff").text(learnerName, 0, 290, { align: "center", width: size });

    doc.moveTo(size / 2 - 40, 320).lineTo(size / 2 + 40, 320).lineWidth(1).strokeColor(BRAND.goldLight).stroke();

    doc.font("Helvetica").fontSize(9).fillColor("#C9D6D4");
    doc.text(issuedDate, 0, 335, { align: "center", width: size });
    doc.text(certificateNumber, 0, 350, { align: "center", width: size });

    doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.goldLight).text("BASELINESKILLS.COM", 0, size - 46, { align: "center", width: size, characterSpacing: 1 });

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// Issues a certificate + badge for a learner completing a course. Idempotent
// (returns the existing certificate if one was already issued) and claims
// the certificate number via an immediate, fully synchronous insert before
// any async PDF work — the same fix applied to invoice numbering after a
// real concurrent-request race condition was found there; applying it here
// from the start rather than waiting to rediscover the identical bug.
async function issueCertificate({ learnerId, courseId, appBaseUrl }) {
  const existing = store.findOne("certificates", (c) => c.learnerId === learnerId && c.courseId === courseId);
  if (existing) return existing;

  const learner = store.findOne("learners", (l) => l.id === learnerId);
  const course = store.findOne("courses", (c) => c.id === courseId);
  const certificateNumber = nextCertificateNumber();
  const issuedDate = new Date().toISOString().slice(0, 10);
  const id = newId("certificate");
  const fileName = `${certificateNumber}.pdf`;
  const badgeFileName = `${certificateNumber}-badge.pdf`;
  const base = appBaseUrl || process.env.APP_BASE_URL || "https://www.baselineskills.com";
  const verifyUrl = `${base}/verify/${id}`;

  const certificate = store.insert("certificates", {
    id,
    learnerId, courseId,
    certificateNumber,
    issuedAt: issuedDate,
    certificateUrl: fileName,
    badgeUrl: badgeFileName,
  });

  await generateCertificatePdf({
    certificateNumber, issuedDate,
    learnerName: learner.name, courseTitle: course.title,
    verifyUrl, filePath: path.join(CERTIFICATE_DIR, fileName),
  });

  await generateBadgePdf({
    certificateNumber, issuedDate,
    learnerName: learner.name, courseTitle: course.title,
    verifyUrl, filePath: path.join(BADGE_DIR, badgeFileName),
  });

  return certificate;
}

// One-time-per-record backfill, run automatically on every app startup
// (see app.js). Design decisions (like the dark-theme redesign, or the
// switch from badgeUrl-as-a-URL to badgeUrl-as-a-filename) only affect
// certificates issued *after* the code change — a certificate generated
// months ago is a real PDF file already sitting on disk, untouched by
// any later code fix. This regenerates any certificate/badge that's
// either missing its file entirely or was created under the old
// badgeUrl convention (a URL like "/verify/..." rather than a real
// filename), bringing every existing record up to the current design.
// Safe to run repeatedly — a certificate whose files already exist and
// whose badgeUrl already looks like a real filename is left untouched.
async function backfillCertificates(appBaseUrl) {
  const all = store.readAll("certificates");
  let regenerated = 0;
  for (const cert of all) {
    const looksLikeOldBadgeUrl = !cert.badgeUrl || cert.badgeUrl.startsWith("/") || cert.badgeUrl.startsWith("http");
    const certFileMissing = !cert.certificateUrl || !fs.existsSync(path.join(CERTIFICATE_DIR, cert.certificateUrl));
    const badgeFileMissing = looksLikeOldBadgeUrl || !fs.existsSync(path.join(BADGE_DIR, cert.badgeUrl));

    if (!certFileMissing && !badgeFileMissing) continue;

    const learner = store.findOne("learners", (l) => l.id === cert.learnerId);
    const course = store.findOne("courses", (c) => c.id === cert.courseId);
    if (!learner || !course) continue; // orphaned record — nothing to regenerate against

    const base = appBaseUrl || process.env.APP_BASE_URL || "https://www.baselineskills.com";
    const verifyUrl = `${base}/verify/${cert.id}`;
    const certFileName = `${cert.certificateNumber}.pdf`;
    const badgeFileName = `${cert.certificateNumber}-badge.pdf`;

    try {
      await generateCertificatePdf({
        certificateNumber: cert.certificateNumber, issuedDate: cert.issuedAt,
        learnerName: learner.name, courseTitle: course.title,
        verifyUrl, filePath: path.join(CERTIFICATE_DIR, certFileName),
      });
      await generateBadgePdf({
        certificateNumber: cert.certificateNumber, issuedDate: cert.issuedAt,
        learnerName: learner.name, courseTitle: course.title,
        verifyUrl, filePath: path.join(BADGE_DIR, badgeFileName),
      });
      store.update("certificates", cert.id, { certificateUrl: certFileName, badgeUrl: badgeFileName });
      regenerated++;
    } catch (e) {
      console.error(`[certificates] backfill failed for ${cert.certificateNumber}:`, e.message);
    }
  }
  if (regenerated > 0) console.log(`[certificates] backfill: regenerated ${regenerated} certificate/badge pair(s) to the current design`);
  return regenerated;
}

module.exports = { issueCertificate, backfillCertificates, CERTIFICATE_DIR, BADGE_DIR };


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

    doc.rect(0, 0, doc.page.width, doc.page.height).fill("#FAFBFC");
    doc.rect(24, 24, doc.page.width - 48, doc.page.height - 48).lineWidth(2).strokeColor("#0F5C56").stroke();

    doc.fontSize(14).fillColor("#5B6577").text("BASELINE SKILLS", 0, 70, { align: "center" });
    doc.fontSize(30).fillColor("#0F5C56").text("Certificate of Completion", 0, 100, { align: "center" });

    doc.fontSize(13).fillColor("#5B6577").text("This certifies that", 0, 170, { align: "center" });
    doc.fontSize(26).fillColor("#1F2937").text(learnerName, 0, 195, { align: "center" });
    doc.fontSize(13).fillColor("#5B6577").text("has successfully completed", 0, 240, { align: "center" });
    doc.fontSize(20).fillColor("#1F2937").text(courseTitle, 0, 265, { align: "center", width: doc.page.width, });

    doc.fontSize(11).fillColor("#5B6577");
    doc.text(`Issued: ${issuedDate}`, 0, 340, { align: "center" });
    doc.text(`Certificate number: ${certificateNumber}`, 0, 358, { align: "center" });
    doc.text(`Verify this certificate: ${verifyUrl}`, 0, 376, { align: "center" });

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
  const base = appBaseUrl || process.env.APP_BASE_URL || "https://baselineskills.com";
  const verifyUrl = `${base}/verify/${id}`;

  const certificate = store.insert("certificates", {
    id,
    learnerId, courseId,
    certificateNumber,
    issuedAt: issuedDate,
    certificateUrl: fileName,
    badgeUrl: `/verify/${id}`,
  });

  await generateCertificatePdf({
    certificateNumber, issuedDate,
    learnerName: learner.name, courseTitle: course.title,
    verifyUrl, filePath: path.join(CERTIFICATE_DIR, fileName),
  });

  return certificate;
}

module.exports = { issueCertificate, CERTIFICATE_DIR };

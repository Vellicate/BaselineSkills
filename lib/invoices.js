// Invoice generation (Master Prompt Section 13). PDFs are stored outside
// the app's code path, same DATA_DIR-relative convention as brochures and
// the SQLite file itself, so they survive redeploys rather than living on
// the ephemeral container filesystem.
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const store = require("./db");
const { newId } = require("./id");

const INVOICE_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), "invoices")
  : path.join(__dirname, "..", "public", "uploads", "invoices");
fs.mkdirSync(INVOICE_DIR, { recursive: true });

// Sequential, human-readable invoice numbers (BS-2026-000001), not the raw
// database id — an id like "reg_1788771255532_15128e0b" is not something
// a business would put on an invoice a customer files for their own
// accounting. Sequential per year, based on how many invoices already
// exist for the current year, rather than a separate counter table — this
// app's volume doesn't need one, and it avoids a second piece of state
// that could drift out of sync with the invoices table itself.
function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const existingThisYear = store.readAll("invoices").filter((i) => i.invoiceNumber && i.invoiceNumber.startsWith(`BS-${year}-`));
  const nextSeq = existingThisYear.length + 1;
  return `BS-${year}-${String(nextSeq).padStart(6, "0")}`;
}

function formatMoney(cents, currency) {
  return `${(currency || "USD").toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

// Builds the actual PDF. Line items follow Section 13 exactly: course fee,
// certification exam (if purchased), discount, taxes, payment gateway
// charges, total, currency, payment reference, student info, invoice
// number and date. Tax and gateway-charge fields are shown as "n/a" rather
// than a fabricated number where this data genuinely isn't available yet
// (VAT calculation and real gateway-fee reporting are separate,
// not-yet-built pieces — see the Gap Analysis) — inventing a number here
// would be worse than admitting what isn't known.
function generateInvoicePdf({ invoiceNumber, invoiceDate, registration, course, examProduct, filePath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(20).fillColor("#0F5C56").text("Baseline Skills", { continued: false });
    doc.fontSize(10).fillColor("#5B6577").text("Requirements Engineering & Business Analysis Training");
    doc.moveDown(1.5);

    doc.fontSize(16).fillColor("#1F2937").text("Invoice", { continued: false });
    doc.fontSize(10).fillColor("#1F2937");
    doc.text(`Invoice number: ${invoiceNumber}`);
    doc.text(`Invoice date: ${invoiceDate}`);
    doc.text(`Payment reference: ${registration.paddleTransactionId || registration.paypalOrderId || "n/a"}`);
    doc.moveDown();

    doc.fontSize(12).text("Billed to:");
    doc.fontSize(10).text(registration.name);
    doc.text(registration.email);
    if (registration.company) doc.text(registration.company);
    doc.moveDown();

    const courseFee = registration.priceCentsCharged - (registration.examPriceCentsCharged || 0);
    const originalCourseFee = course ? course.priceCents : courseFee;
    const originalExamFee = examProduct ? examProduct.priceCents : 0;
    const chargedExamFee = registration.examPriceCentsCharged || 0;
    // The full discount given is the course's discount AND the exam's own
    // discount added together — computing only the course portion here
    // silently understated the customer's true total savings whenever an
    // exam was purchased alongside a discounted course, even though the
    // grand total itself (computed independently from
    // priceCentsCharged) was still arithmetically correct either way.
    const discountAmount = Math.max(0, originalCourseFee - courseFee) + Math.max(0, originalExamFee - chargedExamFee);

    doc.fontSize(12).text("Line items:");
    doc.fontSize(10);
    const tableTop = doc.y + 8;
    doc.text("Description", 50, tableTop);
    doc.text("Amount", 450, tableTop);
    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor("#E2E8F0").stroke();

    let y = tableTop + 22;
    doc.text(`${course ? course.title : registration.courseTitle} — course fee`, 50, y);
    doc.text(formatMoney(courseFee, registration.currency), 450, y);
    y += 18;

    if (registration.certificationExamId && registration.examPriceCentsCharged) {
      doc.text(`${examProduct ? examProduct.certificationName : "Certification exam"}`, 50, y);
      doc.text(formatMoney(registration.examPriceCentsCharged, registration.currency), 450, y);
      y += 18;
    }

    if (discountAmount > 0) {
      doc.fillColor("#16847B").text("Discount applied", 50, y);
      doc.text(`-${formatMoney(discountAmount, registration.currency)}`, 450, y);
      doc.fillColor("#1F2937");
      y += 18;
    }

    doc.text("Taxes", 50, y);
    doc.text("n/a — not yet calculated on this order", 450, y);
    y += 18;
    doc.text("Payment gateway charges", 50, y);
    doc.text("n/a — not reported by the provider yet", 450, y);
    y += 25;

    doc.moveTo(50, y).lineTo(545, y).strokeColor("#1F2937").stroke();
    y += 10;
    doc.fontSize(12).font("Helvetica-Bold");
    doc.text("Total", 50, y);
    doc.text(formatMoney(registration.priceCentsCharged, registration.currency), 450, y);
    doc.font("Helvetica");

    doc.fontSize(9).fillColor("#5B6577").text(
      "Thank you for training with Baseline Skills. This invoice is generated automatically on successful payment confirmation.",
      50, y + 60, { width: 495 }
    );

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// Called once per successful payment (from finalizeRegistration) — creates
// the invoice row and the PDF file together, or returns the existing one if
// this registration already has an invoice (defensive against being called
// twice for the same registration, same idempotency principle as the
// webhook handler itself).
async function createInvoiceForRegistration(registration) {
  const existing = store.findOne("invoices", (i) => i.registrationId === registration.id);
  if (existing) return existing;

  const course = store.findOne("courses", (c) => c.id === registration.courseId);
  const examProduct = registration.certificationExamId ? store.findOne("certification_exams", (e) => e.id === registration.certificationExamId) : null;
  const invoiceNumber = nextInvoiceNumber();
  const invoiceDate = new Date().toISOString().slice(0, 10);
  const fileName = `${invoiceNumber}.pdf`;
  const filePath = path.join(INVOICE_DIR, fileName);

  // Claim the invoice number by inserting the row FIRST, synchronously,
  // immediately after computing it — before the async PDF generation below.
  // better-sqlite3 calls are synchronous, so two requests can never
  // interleave between reading the count and inserting here; the previous
  // version awaited PDF generation (a real yield point) before inserting,
  // which left a genuine window for two concurrent webhook calls to read
  // the same "next" count and then both fail on the invoiceNumber UNIQUE
  // constraint — confirmed with 5 real concurrent requests, 2 of which
  // failed outright and never got an invoice at all. Update() call below
  // just fills in the PDF path once it's ready; the row and its number are
  // already safely claimed by then.
  const invoice = store.insert("invoices", {
    id: newId("invoice"),
    corporateAccountId: null,
    registrationId: registration.id,
    invoiceNumber, invoiceDate,
    amountCents: registration.priceCentsCharged,
    status: "paid",
    dueDate: invoiceDate,
    pdfUrl: fileName,
  });

  await generateInvoicePdf({ invoiceNumber, invoiceDate, registration, course, examProduct, filePath });

  return invoice;
}

module.exports = { createInvoiceForRegistration, INVOICE_DIR };

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const store = require("../lib/db");
const { sendMail, escapeHtml } = require("../lib/mailer");
const { newId } = require("../lib/id");
const createRateLimiter = require("../lib/rate-limiter");
const auth = require("../lib/auth");
const security = require("../lib/security");
const discounts = require("../lib/discounts");
const { MATERIAL_DIR } = require("../lib/materials");

// CSRF protection for every state-changing request on the public site —
// registration, review submission, contact/inquiry forms. Safe to apply
// broadly since requireSameOrigin now exempts GET/HEAD internally; found
// missing entirely during integrated testing across phases (only admin.js
// had any origin check before this).
//
// Excludes /webhooks/* — not because this router defines those routes
// (registration.js does), but because Express runs middleware from every
// router mounted at an overlapping path in order, regardless of which
// router's route eventually handles the request. Without this exclusion
// here too, a real Paddle/PayPal webhook call (no browser Origin/Referer)
// gets rejected by this router's blanket check before it ever reaches
// registration.js's own webhook-aware version of the same middleware —
// exactly what happened until this was caught by testing a real webhook
// call with no Origin header, not just re-confirming the cases that were
// already known to work.
router.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  return security.requireSameOrigin(req, res, next);
});

const { BROCHURE_DIR } = require("../lib/brochures");
const publicCfg = discounts.loadConfig().security;

const formRateLimiter = createRateLimiter({
  windowMs: publicCfg.GENERAL_INQUIRY_FORM_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: publicCfg.GENERAL_INQUIRY_FORM_RATE_LIMIT_MAX,
  keyPrefix: "public_form",
  message: "Too many submissions. Please wait a few minutes before trying again.",
});

const brochureRateLimiter = createRateLimiter({
  windowMs: publicCfg.BROCHURE_REQUEST_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: publicCfg.BROCHURE_REQUEST_RATE_LIMIT_MAX,
  keyPrefix: "brochure_request",
  message: "Too many brochure requests. Please wait a few minutes before trying again.",
});

function publishedCourses() {
  return store.readAll("courses").filter((c) => c.published);
}

router.get("/set-language/:lang", (req, res) => {
  const { SUPPORTED_LANGUAGES } = require("../lib/i18n");
  if (SUPPORTED_LANGUAGES.includes(req.params.lang)) {
    req.session.lang = req.params.lang;
  }
  const back = req.get("Referer");
  // Only redirect back to a same-origin page — an open redirect via a
  // crafted Referer/query value is a real vulnerability class, not a
  // theoretical one, so this is checked rather than trusted blindly.
  res.redirect(back && back.startsWith(`${req.protocol}://${req.get("host")}`) ? back : "/");
});

router.get("/sitemap.xml", (req, res) => {
  const base = "https://baselineskills.com";
  const today = new Date().toISOString().slice(0, 10);
  const staticPages = ["/", "/courses", "/about", "/contact", "/corporate-training", "/resources", "/blog", "/become-a-trainer", "/become-an-affiliate"].map((path) => ({ path, lastmod: today }));
  const courses = publishedCourses().map((c) => ({ path: `/courses/${c.slug}`, lastmod: (c.updatedAt || c.createdAt || today).slice(0, 10) }));
  const blogs = store.readAll("blogs").filter((b) => b.published).map((b) => ({ path: `/blog/${b.slug}`, lastmod: (b.updatedAt || b.createdAt || today).slice(0, 10) }));
  const resources = store.readAll("resources").filter((r) => r.body).map((r) => ({ path: `/resources/${r.slug}`, lastmod: (r.updatedAt || r.createdAt || today).slice(0, 10) }));
  const certifications = store.readAll("standards_bodies").map((b) => ({ path: `/certifications/${b.slug}`, lastmod: today }));
  const trainers = store.readAll("trainers").map((t) => ({ path: `/trainers/${t.id}`, lastmod: today }));
  const entries = [...staticPages, ...courses, ...blogs, ...resources, ...certifications, ...trainers];

  res.setHeader("Content-Type", "application/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.map((e) => `  <url><loc>${base}${e.path}</loc><lastmod>${e.lastmod}</lastmod></url>`).join("\n") +
    `\n</urlset>`
  );
});

router.get("/", (req, res) => {
  const courses = publishedCourses();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = courses
    .flatMap((c) => (c.sessions || []).map((s) => ({ ...s, course: c })))
    .filter((s) => s.startDate !== "On Demand" && new Date(s.startDate) >= today)
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
    .slice(0, 4);

  const categories = ["Requirements Engineering", "Systems Engineering", "Business Analysis", "Project Management", "Business Process Modeling", "AI", "Automotive"];
  const byCategory = {};
  categories.forEach((cat) => {
    byCategory[cat] = courses.filter((c) => c.category === cat).slice(0, 5);
  });

  // The homepage's featured-course card used to be entirely hardcoded static
  // markup — title, perks, and price all fixed text with no connection to
  // the actual course record. That meant it silently drifted out of sync
  // with reality the moment a real price or discount changed (exactly the
  // $899-vs-$899-15%-off inconsistency flagged in review). Now computed
  // from the real course and the same discount logic used everywhere else,
  // so it can never show a stale price again.
  const featuredCourse = courses.find((c) => c.slug === "cpre-foundation-level") || courses[0] || null;
  let featuredPricing = null;
  if (featuredCourse) {
    const nextSession = (featuredCourse.sessions || []).find((s) => s.startDate !== "On Demand" && new Date(s.startDate) >= today);
    const sessionDate = nextSession ? nextSession.startDate : "";
    const discountInfo = discounts.earlyBirdForSession(sessionDate);
    featuredPricing = {
      finalPriceCents: discounts.finalPriceCentsForSession(featuredCourse, sessionDate),
      originalPriceCents: featuredCourse.priceCents,
      discountPercent: discounts.effectiveDiscountPercent(featuredCourse, sessionDate),
      nextSessionDate: sessionDate,
    };
  }

  const siteStats = {
    founded: store.getSetting("stat_founded_year", "2009"),
    rating: store.getSetting("stat_average_rating", "4.8"),
    professionals: store.getSetting("stat_professionals_trained", "20,000+"),
    industries: store.getSetting("stat_industries_served", "10+"),
  };

  res.render("home", { title: "Baseline Skills — Build Skills. Establish Excellence.", metaDescription: "Accredited IREB CPRE, IIBA business analysis, and systems engineering training and certification. Live online and corporate cohorts, taught by practitioners.", byCategory, upcoming, featuredCourse, featuredPricing, siteStats });
});

router.get("/courses", (req, res) => {
  const courses = publishedCourses();
  const category = req.query.category || "All";
  const level = req.query.level || "All";
  const format = req.query.format || "All";
  const q = (req.query.q || "").trim().toLowerCase();
  const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;

  let filtered = category === "All" ? courses : courses.filter((c) => c.category === category);
  if (level !== "All") filtered = filtered.filter((c) => c.level === level);
  if (format !== "All") filtered = filtered.filter((c) => (c.deliveryModes || []).includes(format));
  if (maxPrice != null && !Number.isNaN(maxPrice)) filtered = filtered.filter((c) => (c.priceCents || 0) / 100 <= maxPrice);
  if (q) filtered = filtered.filter((c) => c.title.toLowerCase().includes(q) || (c.summary || "").toLowerCase().includes(q));

  // Log every search so zero-result queries are visible later (Gap Analysis
  // Section 9 — supply/demand reporting depends on this existing).
  if (q) {
    try { store.insert("search_logs", { id: newId("search"), query: q, resultCount: filtered.length, timestamp: new Date().toISOString() }); } catch (e) { /* logging failure shouldn't break the search itself */ }
  }

  const categories = ["All", ...new Set(courses.map((c) => c.category))];
  const levels = ["All", "Beginner", "Intermediate", "Expert"];
  const formats = ["All", ...new Set(courses.flatMap((c) => c.deliveryModes || []))];

  res.render("courses", {
    title: "Courses — Baseline Skills", metaDescription: "Browse accredited requirements engineering, business analysis, and systems engineering courses. Filter by certification body, level, and delivery format.", courses: filtered,
    categories, activeCategory: category,
    levels, activeLevel: level,
    formats, activeFormat: format,
    q, maxPrice: req.query.maxPrice || "",
  });
});

router.get("/trainers/:id", (req, res) => {
  const trainer = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!trainer) return res.status(404).render("404", { title: "Trainer not found" });
  const courses = publishedCourses().filter((c) => c.trainerId === trainer.id);
  res.render("trainer-profile", { title: `${trainer.name} — Baseline Skills`, metaDescription: (trainer.bio || `${trainer.name}, ${trainer.title || "trainer"} at Baseline Skills.`).slice(0, 160), trainer, courses });
});

router.get("/courses/:slug", (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  if (req.query.ref) req.session.refCode = req.query.ref;

  // Prefer explicit course_sequences ("courses to take after this one") over
  // same-category matching, per the reconciled Marketplace Pages structure —
  // falls back to category matching only when no explicit sequence has been
  // set for this course yet (no admin UI to manage course_sequences exists
  // yet, so this keeps the section populated in the meantime).
  const explicitSequences = store.readAll("course_sequences").filter((s) => s.courseId === course.id);
  const related = explicitSequences.length
    ? explicitSequences.map((s) => store.findOne("courses", (c) => c.id === s.nextCourseId)).filter(Boolean)
    : publishedCourses().filter((c) => c.category === course.category && c.id !== course.id).slice(0, 3);

  const trainer = course.trainerId ? store.findOne("trainers", (t) => t.id === course.trainerId) : null;
  const faqs = store.readAll("faqs").filter((f) => f.scope === "course" && f.courseId === course.id && f.published).sort((a, b) => a.order - b.order);
  const reviews = store.readAll("reviews").filter((r) => r.courseId === course.id);
  const avgRating = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) : null;
  const ratingDistribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((r) => r.rating === star).length }));

  let canReview = false;
  let hasAccessToMaterials = false;
  const materials = store.readAll("materials").filter((m) => m.courseId === course.id);
  if (req.session.learnerId) {
    const learner = store.findOne("learners", (l) => l.id === req.session.learnerId);
    const alreadyReviewed = reviews.some((r) => r.learnerId === req.session.learnerId);
    const qualifies = learner && store.findOne("registrations", (r) =>
      r.courseId === course.id &&
      (r.learnerId === learner.id || r.email.toLowerCase() === learner.email.toLowerCase()) &&
      (r.status === "confirmed" || r.status === "invoice_pending")
    );
    canReview = !!qualifies && !alreadyReviewed;
    hasAccessToMaterials = !!qualifies;
  }

  const mapping = store.findOne("course_standards_mapping", (m) => m.courseId === course.id);
  const certificationBody = mapping ? store.findOne("standards_bodies", (b) => b.id === mapping.standardsBodyId) : null;
  res.render("course-detail", { title: `${course.title} — Baseline Skills`, metaDescription: course.summary, course, related, trainer, faqs, reviews, avgRating, ratingDistribution, canReview, materials, hasAccessToMaterials, certificationBody });
});

// Emails a link to the brochure rather than downloading it directly, so we
// capture the requester's email as a lead — the file itself lives at an
// unguessable URL (see lib/brochures.js), not behind real access control.
router.post("/courses/:slug/brochure", brochureRateLimiter, async (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug && c.published);
  if (!course) return res.status(404).json({ error: "Course not found" });
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  if (!course.brochureFilename) {
    return res.status(404).json({ error: "No brochure is available for this course yet." });
  }

  const downloadUrl = `${req.protocol}://${req.get("host")}/brochure/${course.brochureFilename}`;

  await sendMail({
    to: email,
    subject: `Your brochure: ${course.title.replace(/[\r\n]/g, "")}`,
    html: `<p>Thanks for your interest in <strong>${escapeHtml(course.title)}</strong>.</p>
           <p>Download your brochure here: <a href="${downloadUrl}">${downloadUrl}</a></p>
           <p>Questions? Just reply to this email or visit <a href="https://baselineskills.com/contact">our contact page</a>.</p>`,
  });

  // Log it alongside other inquiries so it shows up in the existing admin
  // Inquiries view — no new admin page needed just to see who asked.
  store.insert("inquiries", {
    id: newId("inq"),
    type: "brochure-request",
    name: email.split("@")[0],
    email,
    company: "", teamSize: "", role: "", courseInterest: course.title, deliveryMode: "",
    message: `Requested the brochure for "${course.title}".`,
    createdAt: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// Serves the brochure PDF itself. Deliberately unauthenticated (the whole
// point is a prospect clicking an emailed link, with no account) — the
// filename is a long random ID, which is the only thing standing between
// "public" and "gated" here. See lib/brochures.js for that tradeoff.
router.get("/brochure/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt
  if (!/^[a-z0-9_.-]+\.pdf$/i.test(filename)) return res.status(400).send("Invalid file name");
  const filePath = path.join(BROCHURE_DIR, filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).send("Brochure not found");
  });
});

router.get("/corporate-training", (req, res) => {
  res.render("corporate-training", { title: "Corporate Training — Baseline Skills", metaDescription: "Upskill your engineering, product, and business analysis teams with corporate requirements engineering and systems engineering training programs." });
});

router.post("/corporate-training/inquiry", formRateLimiter, (req, res) => {
  const { name, company, email, phone, teamSize, message } = req.body;
  if (!name || !company || !email) {
    return res.status(400).render("corporate-training", {
      title: "Corporate Training — Baseline Skills",
      error: "Name, company, and email are required.",
      form: req.body,
    });
  }

  const inquiry = {
    id: newId("inq"),
    type: "corporate-training",
    name, company, email, phone: phone || "", teamSize: teamSize || "",
    message: message || "",
    createdAt: new Date().toISOString(),
  };
  store.insert("inquiries", inquiry);

  sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New corporate training inquiry — ${company.replace(/[\r\n]/g, "")}`,
    html: `<p><strong>${escapeHtml(name)}</strong> at <strong>${escapeHtml(company)}</strong> (${escapeHtml(email)}, ${escapeHtml(phone) || "no phone given"}) requested corporate training info.</p>
           <p>Team size: ${escapeHtml(teamSize) || "not specified"}</p>
           <p>Message: ${escapeHtml(message) || "(none)"}</p>`,
  });

  res.render("corporate-training", { title: "Corporate Training — Baseline Skills", metaDescription: "Upskill your engineering, product, and business analysis teams with corporate requirements engineering and systems engineering training programs.", success: true });
});

// For Teams — a corporate group nominating participants into an EXISTING
// public cohort, typically paying via a company purchase order rather than
// individual online checkout. This is a distinct funnel from Corporate
// Training (custom, private programs) — kept separate per that explicit
// clarification, not merged into the existing inquiry type.
router.get("/for-teams/team-cohorts", (req, res) => {
  res.render("for-teams-form", {
    title: "Team Cohorts — Baseline Skills",
    metaDescription: "Nominate a group of colleagues into an upcoming public Baseline Skills cohort — billed by purchase order, not individual checkout.",
    formType: "team-cohorts",
    heading: "Team Cohorts",
    intro: "Send several colleagues to an upcoming public cohort together. We'll confirm seats and invoice your organization directly — no individual online payment needed.",
  });
});

router.post("/for-teams/team-cohorts", formRateLimiter, (req, res) => {
  const { name, company, email, teamSize, courseInterest, deliveryMode, message } = req.body;
  if (!name || !company || !email || !teamSize) {
    return res.status(400).render("for-teams-form", {
      title: "Team Cohorts — Baseline Skills", formType: "team-cohorts", heading: "Team Cohorts",
      intro: "Send several colleagues to an upcoming public cohort together. We'll confirm seats and invoice your organization directly — no individual online payment needed.",
      error: "Name, organization, work email, and number of participants are required.", form: req.body,
    });
  }
  store.insert("inquiries", {
    id: newId("inq"), type: "team-cohort", name, company, email,
    teamSize, courseInterest: courseInterest || "", deliveryMode: deliveryMode || "",
    message: message || "", createdAt: new Date().toISOString(),
  });
  sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New team cohort request — ${company.replace(/[\r\n]/g, "")}`,
    html: `<p><strong>${escapeHtml(name)}</strong> at <strong>${escapeHtml(company)}</strong> (${escapeHtml(email)}) wants to nominate ${escapeHtml(teamSize)} participant(s) into a public cohort.</p>
           <p>Course/interest: ${escapeHtml(courseInterest) || "not specified"}</p>
           <p>Preferred delivery format: ${escapeHtml(deliveryMode) || "not specified"}</p>
           <p>Message: ${escapeHtml(message) || "(none)"}</p>`,
  });
  res.render("for-teams-form", {
    title: "Team Cohorts — Baseline Skills", formType: "team-cohorts", heading: "Team Cohorts",
    intro: "Send several colleagues to an upcoming public cohort together. We'll confirm seats and invoice your organization directly — no individual online payment needed.",
    success: true,
  });
});

router.get("/for-teams/request-conversation", (req, res) => {
  res.render("for-teams-form", {
    title: "Request a Conversation — Baseline Skills",
    metaDescription: "Not sure which path fits your team? Request a short conversation with Baseline Skills.",
    formType: "request-conversation",
    heading: "Request a Conversation",
    intro: "Not sure whether Corporate Learning or Team Cohorts fits better? Tell us a bit about what you need and we'll point you the right way.",
  });
});

router.post("/for-teams/request-conversation", formRateLimiter, (req, res) => {
  const { name, company, email, phone, courseInterest, message } = req.body;
  if (!name || !email) {
    return res.status(400).render("for-teams-form", {
      title: "Request a Conversation — Baseline Skills", formType: "request-conversation", heading: "Request a Conversation",
      intro: "Not sure whether Corporate Learning or Team Cohorts fits better? Tell us a bit about what you need and we'll point you the right way.",
      error: "Name and email are required.", form: req.body,
    });
  }
  store.insert("inquiries", {
    id: newId("inq"), type: "request-conversation", name, company: company || "", email,
    phone: phone || "", courseInterest: courseInterest || "", message: message || "",
    createdAt: new Date().toISOString(),
  });
  sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New conversation request — ${name.replace(/[\r\n]/g, "")}`,
    html: `<p><strong>${escapeHtml(name)}</strong>${company ? ` at <strong>${escapeHtml(company)}</strong>` : ""} (${escapeHtml(email)}, ${escapeHtml(phone) || "no phone given"}) requested a conversation.</p>
           <p>Reason: ${escapeHtml(courseInterest) || "not specified"}</p>
           <p>Message: ${escapeHtml(message) || "(none)"}</p>`,
  });
  res.render("for-teams-form", {
    title: "Request a Conversation — Baseline Skills", formType: "request-conversation", heading: "Request a Conversation",
    intro: "Not sure whether Corporate Learning or Team Cohorts fits better? Tell us a bit about what you need and we'll point you the right way.",
    success: true,
  });
});

router.get("/about", (req, res) => {
  res.render("about", { title: "About Us — Baseline Skills", metaDescription: "Baseline Skills is a specialized training and certification marketplace for requirements engineering, business analysis, and systems engineering practitioners." });
});

// Fixed resource taxonomy per the homepage redesign brief — a constrained
// set of category values (enforced in the admin form as a dropdown, not a
// free-text field), each with its own navigable landing page. "Blog" is
// intentionally not part of this list: it's a distinct, pre-existing content
// type with its own table and route, surfaced under the same Resources nav
// dropdown for the visitor rather than duplicated into this taxonomy.
const RESOURCE_CATEGORIES = [
  { slug: "ba-re", label: "BA & RE" },
  { slug: "systems-engineering", label: "Systems Engineering" },
  { slug: "pm", label: "PM" },
  { slug: "automobile", label: "Automobile" },
];

router.get("/resources", (req, res) => {
  const articles = store.readAll("resources").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("resources", { title: "RE Pulse — Baseline Skills", metaDescription: "RE Pulse — practical articles, guides, and insights on requirements engineering, business analysis, and systems engineering from Baseline Skills.", articles, categories: RESOURCE_CATEGORIES });
});

router.get("/resources/blog", (req, res) => res.redirect("/blog"));

RESOURCE_CATEGORIES.forEach(({ slug, label }) => {
  router.get(`/resources/${slug}`, (req, res) => {
    const articles = store.readAll("resources")
      .filter((r) => r.category === label)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.render("resources", {
      title: `${label} Resources — Baseline Skills`,
      metaDescription: `Practical ${label} articles and guides from Baseline Skills.`,
      articles, categories: RESOURCE_CATEGORIES, activeCategory: label,
    });
  });
});

router.get("/resources/:slug", (req, res) => {
  const resource = store.findOne("resources", (r) => r.slug === req.params.slug);
  if (!resource) return res.status(404).render("404", { title: "Resource not found" });
  // A resource with no body is a legacy/external-link-only entry — send
  // the visitor straight to wherever it actually points rather than
  // rendering an empty detail page for it.
  if (!resource.body && resource.url) return res.redirect(resource.url);
  const related = store.readAll("resources").filter((r) => r.id !== resource.id && r.category === resource.category).slice(0, 3);
  res.render("resource-detail", { title: `${resource.title} — Baseline Skills`, metaDescription: resource.excerpt, resource, related });
});

router.get("/exams", (req, res) => {
  const exams = store.readAll("certification_exams").map((exam) => {
    const course = exam.courseId ? store.findOne("courses", (c) => c.id === exam.courseId && c.published) : null;
    return { ...exam, course };
  });
  res.render("exams", {
    title: "Certification Exams — Baseline Skills",
    metaDescription: "Certification examinations available through Baseline Skills, administered independently of training delivery.",
    exams,
  });
});

router.get("/certifications/:slug", (req, res) => {
  const body = store.findOne("standards_bodies", (b) => b.slug === req.params.slug);
  if (!body) return res.status(404).render("404", { title: "Certification body not found" });
  const mappings = store.readAll("course_standards_mapping").filter((m) => m.standardsBodyId === body.id);
  const courses = mappings.map((m) => store.findOne("courses", (c) => c.id === m.courseId)).filter((c) => c && c.published);
  res.render("certification-body", { title: `${body.name} Certification Training — Baseline Skills`, metaDescription: body.description.slice(0, 160), body, courses });
});

router.get("/blog", (req, res) => {
  const posts = store.readAll("blogs")
    .filter((b) => b.published)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("blog-list", { title: "Blog — Baseline Skills", metaDescription: "Insights, updates, and practical guidance on requirements engineering, business analysis, and systems engineering certification from the Baseline Skills team.", posts });
});

router.get("/blog/:slug", (req, res) => {
  const post = store.findOne("blogs", (b) => b.slug === req.params.slug && b.published);
  if (!post) return res.status(404).render("404", { title: "Post not found" });
  const related = store.readAll("blogs")
    .filter((b) => b.published && b.category === post.category && b.id !== post.id)
    .slice(0, 3);
  res.render("blog-detail", { title: `${post.title} — Baseline Skills`, metaDescription: (post.excerpt || post.title).slice(0, 160), post, related });
});

router.get("/contact", (req, res) => {
  res.render("contact", { title: "Contact — Baseline Skills", metaDescription: "Get in touch with Baseline Skills for course enquiries, corporate training requests, or general questions about our certification programs." });
});

router.post("/contact", formRateLimiter, (req, res) => {
  const { name, email, company, role, courseInterest, teamSize, deliveryMode, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).render("contact", { title: "Contact — Baseline Skills", error: "Name, email, and message are required.", form: req.body });
  }

  const contactEntry = {
    id: newId("contact"),
    type: "contact",
    name, email, company: company || "", role: role || "",
    courseInterest: courseInterest || "", teamSize: teamSize || "",
    deliveryMode: deliveryMode || "", message,
    createdAt: new Date().toISOString(),
  };
  store.insert("inquiries", contactEntry);

  sendMail({
    to: process.env.ADMIN_EMAIL || "admin@baselineskills.example",
    subject: `New contact form message — ${name.replace(/[\r\n]/g, "")}`,
    html: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) sent a message.</p>
           <p>Company: ${escapeHtml(company) || "n/a"} · Role: ${escapeHtml(role) || "n/a"} · Course interest: ${escapeHtml(courseInterest) || "n/a"} · Team size: ${escapeHtml(teamSize) || "n/a"} · Preferred mode: ${escapeHtml(deliveryMode) || "n/a"}</p>
           <p>${escapeHtml(message)}</p>`,
  });

  res.render("contact", { title: "Contact — Baseline Skills", metaDescription: "Get in touch with Baseline Skills for course enquiries, corporate training requests, or general questions about our certification programs.", success: true });
});

const reviewRateLimiter = createRateLimiter({
  windowMs: publicCfg.REVIEW_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: publicCfg.REVIEW_RATE_LIMIT_MAX,
  keyPrefix: "review_submit",
  message: "Too many reviews submitted. Please try again later.",
});

router.post("/courses/:slug/review", reviewRateLimiter, auth.requireLearner, (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  const learner = store.findOne("learners", (l) => l.id === req.session.learnerId);

  // Verified purchase: a confirmed or invoice-pending registration for this
  // course under the learner's own account email — pending_payment (an
  // abandoned checkout) does not qualify.
  const qualifyingRegistration = store.findOne("registrations", (r) =>
    r.courseId === course.id &&
    (r.learnerId === learner.id || r.email.toLowerCase() === learner.email.toLowerCase()) &&
    (r.status === "confirmed" || r.status === "invoice_pending")
  );
  if (!qualifyingRegistration) {
    return res.status(403).send("You need a confirmed registration for this course before you can leave a review.");
  }

  const existingReview = store.findOne("reviews", (r) => r.learnerId === learner.id && r.courseId === course.id);
  if (existingReview) {
    return res.status(400).send("You've already reviewed this course.");
  }

  const rating = Number(req.body.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).send("Rating must be between 1 and 5.");
  }

  store.insert("reviews", {
    id: newId("review"), learnerId: learner.id, courseId: course.id,
    rating, comment: req.body.comment || "", verifiedPurchase: true,
    createdAt: new Date().toISOString(),
  });
  res.redirect(`/courses/${course.slug}?success=Review+submitted#reviews`);
});

// Course materials — access-controlled, never a public URL. A learner must
// be logged in AND have a qualifying (confirmed or invoice-pending)
// registration for THIS specific course — the same eligibility check as
// review submission, since both represent "did they actually buy this."
router.get("/courses/:slug/materials/:materialId/download", auth.requireLearner, (req, res) => {
  const course = store.findOne("courses", (c) => c.slug === req.params.slug);
  if (!course) return res.status(404).render("404", { title: "Course not found" });
  const material = store.findOne("materials", (m) => m.id === req.params.materialId && m.courseId === course.id);
  if (!material) return res.status(404).render("404", { title: "Material not found" });

  const learner = store.findOne("learners", (l) => l.id === req.session.learnerId);
  const qualifies = store.findOne("registrations", (r) =>
    r.courseId === course.id &&
    (r.learnerId === learner.id || r.email.toLowerCase() === learner.email.toLowerCase()) &&
    (r.status === "confirmed" || r.status === "invoice_pending")
  );
  if (!qualifies) return res.status(403).send("You need a confirmed registration for this course to access its materials.");

  const filePath = path.join(MATERIAL_DIR, material.filePath);
  if (!fs.existsSync(filePath)) return res.status(404).render("404", { title: "Material file not found" });
  res.download(filePath, material.title + path.extname(material.filePath));
});

// Public certificate/badge verification — deliberately no login required.
// This IS the shareable digital badge: the whole point of Section 18's
// "verification link, suitable for sharing on professional/social
// profiles" is that anyone who receives the link (a recruiter, a
// colleague) can confirm it's real without needing an account themselves.
router.get("/verify/:id", (req, res) => {
  const certificate = store.findOne("certificates", (c) => c.id === req.params.id);
  if (!certificate) return res.status(404).render("verify", { title: "Certificate not found — Baseline Skills", certificate: null, learner: null, course: null });
  const learner = store.findOne("learners", (l) => l.id === certificate.learnerId);
  const course = store.findOne("courses", (c) => c.id === certificate.courseId);
  res.render("verify", { title: `Verified: ${learner.name} — Baseline Skills`, noindex: true, certificate, learner, course });
});

module.exports = router;


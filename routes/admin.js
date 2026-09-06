const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const store = require("../lib/store");
const { newId } = require("../lib/id");
const slugify = require("slugify");
const createRateLimiter = require("../lib/rate-limiter");
const multer = require("multer");
const { BROCHURE_DIR } = require("../lib/brochures");

const brochureUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, BROCHURE_DIR),
    filename: (req, file, cb) => cb(null, `${newId("brochure")}.pdf`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Brochure must be a PDF file"));
    }
    cb(null, true);
  },
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "admin_login",
  message: "Too many admin login attempts. Please wait 15 minutes.",
});

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}

function verifyOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.headers["origin"] || req.headers["referer"];
  if (!origin) return res.status(403).send("Missing origin header");
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.host;
    if (originHost !== reqHost) {
      return res.status(403).send("Cross-site request forgery blocked");
    }
  } catch (e) {
    return res.status(403).send("Invalid origin header");
  }
  next();
}

// Helper to pull flash message params from query strings
function getAlerts(req) {
  return {
    success: req.query.success || null,
    error: req.query.error || null,
  };
}

// ---- Auth ----
router.get("/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.render("admin/login", { title: "Admin login — Baseline Skills" });
});

router.post("/login", loginRateLimiter, (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";

  if (safeCompare(password, adminPassword)) {
    return req.session.regenerate((err) => {
      if (err) {
        return res.status(500).render("admin/login", { 
          title: "Admin login — Baseline Skills", 
          error: "Session creation error." 
        });
      }
      req.session.isAdmin = true;
      return res.redirect("/admin?success=Welcome+back!");
    });
  }
  res.render("admin/login", { title: "Admin login — Baseline Skills", error: "Incorrect password." });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

router.use(requireAdmin); // everything below this line requires admin auth
router.use(verifyOrigin); // enforce CSRF origin protection for admin POST requests


// ---- Enhanced Dashboard & Visual Analytics ----
router.get("/", (req, res) => {
  const courses = store.readAll("courses");
  const registrations = store.readAll("registrations").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const inquiries = store.readAll("inquiries").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const confirmedRegs = registrations.filter((r) => r.status === "confirmed" || r.status === "invoice_pending");
  const revenueCents = confirmedRegs.reduce((sum, r) => sum + (r.priceCentsCharged || 0), 0);

  // Group metrics for visual charts
  const statusCounts = registrations.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  res.render("admin/dashboard", {
    title: "Admin dashboard — Baseline Skills",
    ...getAlerts(req),
    courseCount: courses.length,
    publishedCount: courses.filter((c) => c.published).length,
    registrationCount: registrations.length,
    inquiryCount: inquiries.length,
    revenueDisplay: (revenueCents / 100).toFixed(2),
    statusCounts,
    recentRegistrations: registrations.slice(0, 8),
    recentInquiries: inquiries.slice(0, 5),
  });
});

// ---- Dynamic Data Export (CSV) ----
router.get("/export/:type", (req, res) => {
  const { type } = req.params;
  
  if (type === "registrations") {
    const data = store.readAll("registrations");
    let csv = "ID,Name,Email,Course,Status,Price Charged,Created At\n";
    data.forEach((r) => {
      csv += `"${r.id}","${r.name || ""}","${r.email || ""}","${r.courseTitle || ""}","${r.status || ""}","${((r.priceCentsCharged || 0) / 100).toFixed(2)}","${r.createdAt}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="registrations.csv"');
    return res.send(csv);
  }

  if (type === "inquiries") {
    const data = store.readAll("inquiries");
    let csv = "ID,Name,Email,Subject,Message,Created At\n";
    data.forEach((i) => {
      csv += `"${i.id}","${i.name || ""}","${i.email || ""}","${i.subject || ""}","${(i.message || "").replace(/"/g, '""')}","${i.createdAt}"\n`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="inquiries.csv"');
    return res.send(csv);
  }

  res.status(400).send("Invalid export type");
});

// ---- Course list ----
router.get("/courses", (req, res) => {
  const courses = store.readAll("courses");
  res.render("admin/courses-list", { 
    title: "Manage courses — Baseline Skills", 
    courses,
    ...getAlerts(req)
  });
});

function courseFromForm(body, existing, uploadedFile) {
  const outcomes = (body.outcomes || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const audience = (body.audience || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const prerequisites = (body.prerequisites || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const whatYoullReceive = (body.whatYoullReceive || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const deliveryModes = Array.isArray(body.deliveryModes) ? body.deliveryModes : (body.deliveryModes ? [body.deliveryModes] : []);

  const curriculumRaw = (body.curriculumRaw || "").trim();
  const curriculum = curriculumRaw
    ? curriculumRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [modulePart, topicsPart] = line.split(":");
          return {
            module: (modulePart || "").trim(),
            topics: (topicsPart || "").split(",").map((t) => t.trim()).filter(Boolean),
          };
        })
        .filter((m) => m.module)
    : (existing ? existing.curriculum || [] : []);

  const sessionStarts = Array.isArray(body.sessionStartDate) ? body.sessionStartDate : [body.sessionStartDate].filter(Boolean);
  const sessionEnds = Array.isArray(body.sessionEndDate) ? body.sessionEndDate : [body.sessionEndDate].filter(Boolean);
  const sessionTimeFroms = Array.isArray(body.sessionTimeFrom) ? body.sessionTimeFrom : [body.sessionTimeFrom].filter(Boolean);
  const sessionTimeTos = Array.isArray(body.sessionTimeTo) ? body.sessionTimeTo : [body.sessionTimeTo].filter(Boolean);
  const sessionModes = Array.isArray(body.sessionMode) ? body.sessionMode : [body.sessionMode].filter(Boolean);
  const sessionSeats = Array.isArray(body.sessionSeats) ? body.sessionSeats : [body.sessionSeats].filter(Boolean);
  const sessions = sessionStarts
    .map((startDate, i) => ({
      startDate,
      endDate: sessionEnds[i] || "",
      timeFrom: sessionTimeFroms[i] || "",
      timeTo: sessionTimeTos[i] || "",
      mode: sessionModes[i] || deliveryModes[0] || "Live Online",
      seatsLeft: sessionSeats[i] ? Number(sessionSeats[i]) : null,
    }))
    .filter((s) => s.startDate);

  return {
    ...existing,
    title: body.title,
    slug: existing && existing.slug ? existing.slug : slugify(body.title || "course", { lower: true, strict: true }),
    category: body.category,
    summary: body.summary,
    description: body.description,
    outcomes,
    curriculum: curriculum,
    audience,
    durationDays: Number(body.durationDays) || 1,
    deliveryModes: deliveryModes.length ? deliveryModes : ["Live Online"],
    priceCents: Math.round(Number(body.price || 0) * 100),
    discountPercent: Number(body.discountPercent || 0),
    currency: body.currency || "USD",
    certification: !!body.certification,
    sessions,
    corporateOnly: !!body.corporateOnly,
    published: !!body.published,
    courseOutlineUrl: body.courseOutlineUrl || "",
    trainerId: body.trainerId || "",
    whyTakeThisCourse: body.whyTakeThisCourse || "",
    prerequisites,
    formatAndMaterial: body.formatAndMaterial || "",
    whatYoullReceive,
    brochureFilename: uploadedFile ? uploadedFile.filename : (existing ? existing.brochureFilename : ""),
  };
}

function handleBrochureUpload(req, res, next) {
  brochureUpload.single("brochure")(req, res, (err) => {
    if (!err) return next();
    const isEdit = req.params.id != null;
    const course = isEdit ? store.findOne("courses", (c) => c.id === req.params.id) : null;
    res.status(400).render("admin/course-form", {
      title: isEdit ? `Edit ${course ? course.title : ""} — Baseline Skills` : "New course — Baseline Skills",
      course,
      mode: isEdit ? "edit" : "new",
      trainers: store.readAll("trainers"),
      error: err.message === "Brochure must be a PDF file" ? err.message : "Brochure upload failed — please try a PDF under 15MB.",
    });
  });
}

router.get("/courses/new", (req, res) => {
  res.render("admin/course-form", { 
    title: "New course — Baseline Skills", 
    course: null, 
    mode: "new", 
    trainers: store.readAll("trainers"),
    ...getAlerts(req)
  });
});

router.post("/courses/new", handleBrochureUpload, (req, res) => {
  const course = courseFromForm(req.body, { id: newId("course") }, req.file);
  store.insert("courses", course);
  res.redirect("/admin/courses?success=Course+created+successfully");
});

// ---- Edit course ----
router.get("/courses/:id/edit", (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (!course) return res.status(404).send("Course not found");
  res.render("admin/course-form", { 
    title: `Edit ${course.title} — Baseline Skills`, 
    course, 
    mode: "edit", 
    trainers: store.readAll("trainers"),
    ...getAlerts(req)
  });
});

router.post("/courses/:id/edit", handleBrochureUpload, (req, res) => {
  const existing = store.findOne("courses", (c) => c.id === req.params.id);
  if (!existing) return res.status(404).send("Course not found");
  const updated = courseFromForm(req.body, existing, req.file);
  store.update("courses", req.params.id, updated);
  res.redirect("/admin/courses?success=Course+updated+successfully");
});

router.post("/courses/:id/delete", (req, res) => {
  store.remove("courses", req.params.id);
  res.redirect("/admin/courses?success=Course+deleted");
});

router.post("/courses/:id/toggle-published", (req, res) => {
  const course = store.findOne("courses", (c) => c.id === req.params.id);
  if (course) store.update("courses", req.params.id, { published: !course.published });
  res.redirect("/admin/courses?success=Status+updated");
});

// ---- Registrations ----
router.get("/registrations", (req, res) => {
  const registrations = store.readAll("registrations").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/registrations", { 
    title: "Registrations — Baseline Skills", 
    registrations,
    ...getAlerts(req)
  });
});

// ---- Inquiries (contact + corporate) ----
router.get("/inquiries", (req, res) => {
  const inquiries = store.readAll("inquiries").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/inquiries", { 
    title: "Inquiries — Baseline Skills", 
    inquiries,
    ...getAlerts(req)
  });
});

// ==================== Trainers ====================
router.get("/trainers", (req, res) => {
  const trainers = store.readAll("trainers");
  res.render("admin/trainers-list", { 
    title: "Manage trainers — Baseline Skills", 
    trainers,
    ...getAlerts(req)
  });
});

router.get("/trainers/new", (req, res) => {
  res.render("admin/trainer-form", { 
    title: "New trainer — Baseline Skills", 
    trainer: null, 
    mode: "new",
    ...getAlerts(req)
  });
});

router.post("/trainers/new", (req, res) => {
  const { name, title, bio, profileUrl } = req.body;
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: "New trainer — Baseline Skills", trainer: req.body, mode: "new",
      error: "Name and profile link are required.",
    });
  }
  store.insert("trainers", {
    id: newId("trainer"), name, title: title || "", bio: bio || "", profileUrl,
    createdAt: new Date().toISOString(),
  });
  res.redirect("/admin/trainers?success=Trainer+added");
});

router.get("/trainers/:id/edit", (req, res) => {
  const trainer = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!trainer) return res.status(404).send("Trainer not found");
  res.render("admin/trainer-form", { 
    title: `Edit ${trainer.name} — Baseline Skills`, 
    trainer, 
    mode: "edit",
    ...getAlerts(req)
  });
});

router.post("/trainers/:id/edit", (req, res) => {
  const existing = store.findOne("trainers", (t) => t.id === req.params.id);
  if (!existing) return res.status(404).send("Trainer not found");
  const { name, title, bio, profileUrl } = req.body;
  if (!name || !profileUrl) {
    return res.status(400).render("admin/trainer-form", {
      title: `Edit ${existing.name} — Baseline Skills`, trainer: { ...existing, ...req.body }, mode: "edit",
      error: "Name and profile link are required.",
    });
  }
  store.update("trainers", req.params.id, { name, title: title || "", bio: bio || "", profileUrl });
  res.redirect("/admin/trainers?success=Trainer+updated");
});

router.post("/trainers/:id/delete", (req, res) => {
  const referencingCourses = store.readAll("courses").filter((c) => c.trainerId === req.params.id);
  if (referencingCourses.length) {
    const trainers = store.readAll("trainers");
    return res.status(400).render("admin/trainers-list", {
      title: "Manage trainers — Baseline Skills",
      trainers,
      error: `Can't delete — this trainer is assigned to ${referencingCourses.length} course(s): ${referencingCourses.map((c) => c.title).join(", ")}. Reassign those courses first.`,
    });
  }
  store.remove("trainers", req.params.id);
  res.redirect("/admin/trainers?success=Trainer+deleted");
});

// ==================== Blogs ====================
router.get("/blogs", (req, res) => {
  const blogs = store.readAll("blogs").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/blogs-list", { 
    title: "Manage blog posts — Baseline Skills", 
    blogs,
    ...getAlerts(req)
  });
});

function blogFromForm(body, existing) {
  return {
    ...existing,
    title: body.title,
    slug: existing && existing.slug ? existing.slug : slugify(body.title || "post", { lower: true, strict: true }),
    excerpt: body.excerpt,
    body: body.body,
    author: body.author || "Baseline Skills Team",
    category: body.category || "Requirements Engineering",
    published: !!body.published,
    updatedAt: new Date().toISOString(),
  };
}

router.get("/blogs/new", (req, res) => {
  res.render("admin/blog-form", { 
    title: "New blog post — Baseline Skills", 
    blog: null, 
    mode: "new",
    ...getAlerts(req)
  });
});

router.post("/blogs/new", (req, res) => {
  if (!req.body.title || !req.body.body) {
    return res.status(400).render("admin/blog-form", { title: "New blog post — Baseline Skills", blog: req.body, mode: "new", error: "Title and body are required." });
  }
  const blog = blogFromForm(req.body, { id: newId("blog"), createdAt: new Date().toISOString() });
  store.insert("blogs", blog);
  res.redirect("/admin/blogs?success=Blog+post+published");
});

router.get("/blogs/:id/edit", (req, res) => {
  const blog = store.findOne("blogs", (b) => b.id === req.params.id);
  if (!blog) return res.status(404).send("Blog post not found");
  res.render("admin/blog-form", { 
    title: `Edit ${blog.title} — Baseline Skills`, 
    blog, 
    mode: "edit",
    ...getAlerts(req)
  });
});

router.post("/blogs/:id/edit", (req, res) => {
  const existing = store.findOne("blogs", (b) => b.id === req.params.id);
  if (!existing) return res.status(404).send("Blog post not found");
  if (!req.body.title || !req.body.body) {
    return res.status(400).render("admin/blog-form", { title: `Edit ${existing.title} — Baseline Skills`, blog: { ...existing, ...req.body }, mode: "edit", error: "Title and body are required." });
  }
  const updated = blogFromForm(req.body, existing);
  store.update("blogs", req.params.id, updated);
  res.redirect("/admin/blogs?success=Blog+post+updated");
});

router.post("/blogs/:id/delete", (req, res) => {
  store.remove("blogs", req.params.id);
  res.redirect("/admin/blogs?success=Blog+post+deleted");
});

router.post("/blogs/:id/toggle-published", (req, res) => {
  const blog = store.findOne("blogs", (b) => b.id === req.params.id);
  if (blog) store.update("blogs", req.params.id, { published: !blog.published });
  res.redirect("/admin/blogs?success=Status+updated");
});

// ==================== Resources ====================
router.get("/resources", (req, res) => {
  const resources = store.readAll("resources").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render("admin/resources-list", { 
    title: "Manage resources — Baseline Skills", 
    resources,
    ...getAlerts(req)
  });
});

router.get("/resources/new", (req, res) => {
  res.render("admin/resource-form", { 
    title: "New resource — Baseline Skills", 
    resource: null, 
    mode: "new",
    ...getAlerts(req)
  });
});

router.post("/resources/new", (req, res) => {
  const { title, category, excerpt, url } = req.body;
  if (!title || !excerpt || !url) {
    return res.status(400).render("admin/resource-form", { title: "New resource — Baseline Skills", resource: req.body, mode: "new", error: "Title, excerpt, and link are required." });
  }
  store.insert("resources", {
    id: newId("res"),
    slug: slugify(title, { lower: true, strict: true }),
    title, category: category || "Requirements Engineering", excerpt, url,
    createdAt: new Date().toISOString(),
  });
  res.redirect("/admin/resources?success=Resource+created");
});

router.get("/resources/:id/edit", (req, res) => {
  const resource = store.findOne("resources", (r) => r.id === req.params.id);
  if (!resource) return res.status(404).send("Resource not found");
  res.render("admin/resource-form", { 
    title: `Edit ${resource.title} — Baseline Skills`, 
    resource, 
    mode: "edit",
    ...getAlerts(req)
  });
});

router.post("/resources/:id/edit", (req, res) => {
  const existing = store.findOne("resources", (r) => r.id === req.params.id);
  if (!existing) return res.status(404).send("Resource not found");
  const { title, category, excerpt, url } = req.body;
  if (!title || !excerpt || !url) {
    return res.status(400).render("admin/resource-form", { title: `Edit ${existing.title} — Baseline Skills`, resource: { ...existing, ...req.body }, mode: "edit", error: "Title, excerpt, and link are required." });
  }
  store.update("resources", req.params.id, { title, category: category || existing.category, excerpt, url });
  res.redirect("/admin/resources?success=Resource+updated");
});

router.post("/resources/:id/delete", (req, res) => {
  store.remove("resources", req.params.id);
  res.redirect("/admin/resources?success=Resource+deleted");
});

module.exports = router;

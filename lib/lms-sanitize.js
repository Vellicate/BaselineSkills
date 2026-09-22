const sanitizeHtml = require("sanitize-html");

// LMS Section 12's exact requirement: sanitize HTML server-side, never
// trust client-side sanitization, prevent XSS, sanitize links/attributes.
// This is the ONLY place lesson body HTML is sanitized -- every route that
// accepts lesson content must pass it through this function before it
// ever reaches the database, not just before rendering, since the stored
// value is also what other teachers/admins could eventually see.
const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "p", "br", "strong", "b", "em", "i", "u",
  "ul", "ol", "li", "a", "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
];

const ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "target", "rel"],
};

function sanitizeLessonHtml(rawHtml) {
  return sanitizeHtml(rawHtml || "", {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    // Only allow genuinely safe link protocols -- blocks javascript:,
    // data:, vbscript: URIs, the classic href-based XSS vector this
    // allowlist would otherwise still leave open even with the tag/
    // attribute restrictions above.
    allowedSchemes: ["http", "https", "mailto"],
    // Every link a teacher writes gets rel="noopener noreferrer" and
    // opens in a new tab -- a lesson linking off-site shouldn't be able
    // to navigate the learner's LMS tab away via window.opener, and
    // shouldn't silently replace the course player either.
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
    // Strip disallowed tags' content only for script/style -- for
    // anything else disallowed, keep the inner text rather than deleting
    // a teacher's words because they used an unsupported tag.
    nonTextTags: ["script", "style", "iframe", "object", "embed"],
  });
}

module.exports = { sanitizeLessonHtml };

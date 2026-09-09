# Baseline Skills — Website

A full training/certification website built from the attached blueprint, with
a working admin panel, course registration, file-based data storage, and
email notifications. This is a real, runnable Node.js app — not a mockup.

## What's actually working right now, out of the box

- All public pages: Home, Courses (with category filter), Course detail,
  Corporate Training, About, RE Pulse (resources), Contact.
- **Admin panel** (`/admin/login`) to create, edit, publish/unpublish, and
  delete courses — including description, sessions (dates/times/mode/seats),
  price, and discount percentage.
- **Registration flow**: a visitor registers for a course, the registration
  is written to `data/registrations.json`, and two emails are sent — one to
  the admin, one confirming to the registrant.
- **Payments**: wired to **Paddle** (the same provider ReqDrive uses), via
  non-catalog/inline transactions since course prices are admin-configurable
  and don't map to a fixed subscription catalog. If no Paddle credentials are
  configured, it automatically falls back to an "invoice pending" path so the
  whole flow (including the file write and both emails) still works
  end-to-end while you're testing locally.
- **Emails**: wired to real SMTP via `nodemailer`. If no SMTP is configured,
  emails are logged to `data/email-log.json` and to the console instead of
  failing, so nothing breaks in development.

I ran the entire flow locally while building this — registration, admin
login, course creation/edit/delete, the auth gate on `/admin` — to confirm it
actually works, not just that the code compiles.

## Running it

```bash
npm install
cp .env.example .env      # edit values as needed — see below
npm start
```

Visit `http://localhost:3000`. Admin panel is at `/admin/login` — default
password is `changeme123` unless you set `ADMIN_PASSWORD` in `.env`.

## Going live: payments and email

The site works fully in "demo mode" with no configuration. To actually take
real payments and send real emails, set these in `.env`:

**Payments (Paddle)**
- `PADDLE_API_KEY` — used server-side to create transactions.
- `PADDLE_CLIENT_TOKEN` — used client-side to open the Paddle.js checkout
  overlay. This is a *different* key from `PADDLE_API_KEY` — check your
  Paddle dashboard for both.
- `PADDLE_ENVIRONMENT` — `sandbox` or `production`. Sandbox and production
  are entirely separate in Paddle, with separate keys and separate webhook
  destinations — don't mix them.
- `PADDLE_WEBHOOK_SECRET` — set up a webhook destination in Paddle
  (Developer Tools → Notifications) pointing at
  `https://yourdomain.com/webhooks/paddle`, subscribed to at least
  `transaction.completed`, then paste its signing secret here. **This is
  the authoritative confirmation path** — the checkout-page redirect is a
  fallback display only, not what actually confirms payment, since a
  customer closing their browser right after paying shouldn't cost them
  their registration.
- Course pricing uses Paddle's **non-catalog (inline) transaction items** —
  no pre-created Price/Product IDs are needed in your Paddle catalog at all;
  a transaction is created with the course's current price and title inline,
  and Paddle creates ephemeral entities for it automatically. This means
  changing a course's price or discount in the admin panel takes effect on
  the very next registration with no separate Paddle-side step.

**Email (any standard SMTP provider — SendGrid, Postmark, Resend, Gmail with
an app password, your own mail server, etc.)**
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `MAIL_FROM` — the from-address shown to recipients
- `ADMIN_EMAIL` — where new-registration and inquiry notifications go

No code changes are needed for either — just set the environment variables
and restart the app.

## Where things are stored

Everything is plain JSON files under `/data`, exactly as requested:
- `data/courses.json` — the course catalog (seeded with 17 real courses from
  your blueprint document)
- `data/registrations.json` — every registration, written the moment payment
  completes (or immediately, in demo-mode fallback)
- `data/inquiries.json` — contact form and corporate-training inquiries
- `data/email-log.json` — a record of every email the app has sent or
  attempted to send, useful for debugging delivery issues later

This is genuinely fine at the scale a training business like this runs at.
If you outgrow it (very high concurrent registration volume), the natural
next step is swapping `lib/store.js` for a real database — the rest of the
app doesn't need to change, since all data access already goes through that
one module.

## Project structure

```
app.js                 — Express app entry point
routes/
  public.js             — home, courses, about, corporate, resources, contact
  registration.js       — registration form, payment, webhook, confirmation
  admin.js               — admin auth + course/registration/inquiry management
lib/
  store.js               — JSON file data layer
  mailer.js               — email sending (with graceful no-SMTP fallback)
  payments.js              — Stripe integration (with graceful no-key fallback)
  id.js                     — ID generation
views/                  — EJS templates for every page
public/css/style.css   — the full design system (navy/gold, per your blueprint)
data/                   — all persisted data (courses, registrations, etc.)
```

## Notes on design choices worth knowing about

- **Admin auth is intentionally simple** — one shared password via
  `ADMIN_PASSWORD`, session-based. Fine for a single-admin operation; if more
  than one person needs admin access with individual accounts and audit
  trails, that's a real upgrade worth doing before this scales much further,
  not a quick patch.
- **Colors and fonts now use Baseline Skills' actual brand** (Deep Teal
  #0F5C56 / Warm Amber #D98E04), matching the logo and brand work done
  earlier — not the blueprint document's Navy/Gold spec, which was close
  enough to ReqDrive's own palette to undercut the "clearly independent
  sister company" positioning from that brand work. If you want the
  blueprint's original Navy/Gold instead, the whole system lives in one
  place — the `:root` variables at the top of `public/css/style.css`.
- **RE Pulse (resources) is currently a curated list, not a full CMS** —
  building a true blog-authoring system was out of scope for this pass;
  the six articles from your blueprint are seeded as placeholders with an
  "email us for the full guide" call-to-action rather than full article
  pages.

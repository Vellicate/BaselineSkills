# Regression Testing Report — After the Trainer Dashboard Scoping Fix

Scope: targeted verification of what the last fix specifically touched, plus a full
end-to-end regression of the entire system, to confirm nothing broke as a side effect.

## Verified — the fix's actual claims, not just re-asserted

- **A cross-course referral commission is still correctly credited and payable**, exactly
  as claimed when the fix was made — not just asserted again. Generated a real payout for
  an instructor whose only commission-bearing sale was a referral to a course they don't
  teach: the payout was created with exactly one line item, and the amount matched the
  actual course price at the 80% instructor-referred rate to the cent ($519.20 on a
  $649.00 sale) — confirming the earlier claim ("still correctly credited and paid via the
  real payout system") was true, not just plausible-sounding.
- **An instructor with zero assigned courses but an existing cross-course referral** shows
  a clean, correct empty state ("No courses assigned," $0.00 earned) — no crash, and the
  referral is correctly excluded rather than accidentally leaking through as an edge case
  the main fix didn't anticipate.
- **An instructor teaching two courses** sees earnings correctly aggregated across both —
  confirming the fix restricts to "courses I teach" generally, not accidentally to only the
  first course found.

## A related, more general check prompted by last session's process

Since last session's investigation ended up being about a case-sensitivity mismatch in my
own test tooling (not the app), it was worth checking whether the *application itself* has
any such issue for real users — it doesn't. Trainer login, learner signup, and learner
login were all tested with genuinely mixed-case email input, and all succeeded correctly
against the lowercased stored values. This confirms the earlier finding was specifically a
test-script bug, not a narrowly-missed instance of a real one.

## Full end-to-end regression

Every public route, plus the complete chain — signup, registration with phone/address,
duplicate-registration blocking, a genuine signed-webhook payment confirmation, invoice
generation, certificate issuance, review submission, the admin feedback report, and the
scoped CSV export correctly containing the new phone field — all confirmed working
together in one continuous pass.

## Confirmation

Nothing in this pass was taken on faith: the payout claim was verified by actually
generating one and checking the cents, the "no crash" edge cases were constructed
deliberately rather than assumed safe, and the case-sensitivity check was run against the
real login routes rather than left as an open question from last session.

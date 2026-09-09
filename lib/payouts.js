// Payout generation (Master Prompt Section 28). No real payout API is
// wired up — this is deliberately the "payout abstraction and
// payment-status workflow" the Master Prompt asks for as the honest
// alternative: a real pending/processed/failed record an admin updates
// once money has actually moved by whatever real means, never a
// hard-coded "paid" flag.
const store = require("./db");
const { newId } = require("./id");
const commissions = require("./commissions");

/**
 * Every registration already commission-attributed to this exact
 * recipient, confirmed within the period, and not already claimed by an
 * earlier payout (checked via payout_line_items, not the registration
 * itself, since a registration has no "already paid out" flag of its
 * own — the line item table is the single source of truth for that).
 */
function eligibleRegistrationsFor(recipientType, recipientId, periodStart, periodEnd) {
  const alreadyPaidRegistrationIds = new Set(store.readAll("payout_line_items").map((li) => li.registrationId));
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  return store.readAll("registrations").filter((r) => {
    if (r.status !== "confirmed" && r.status !== "invoice_pending") return false;
    if (!r.confirmedAt) return false;
    const confirmedDate = new Date(r.confirmedAt);
    if (confirmedDate < start || confirmedDate > end) return false;
    if (alreadyPaidRegistrationIds.has(r.id)) return false;

    const commission = commissions.calculateCommission(r);
    return commission.recipientType === recipientType && commission.recipientId === recipientId && commission.commissionCents > 0;
  });
}

function generatePayout({ recipientType, recipientId, periodStart, periodEnd }) {
  const eligible = eligibleRegistrationsFor(recipientType, recipientId, periodStart, periodEnd);
  if (eligible.length === 0) return { created: false, reason: "No unpaid, commission-eligible sales found in this period." };

  const payout = store.insert("payouts", {
    id: newId("payout"), recipientType, recipientId,
    periodStart, periodEnd, totalAmountCents: 0, status: "pending", paidAt: null,
  });

  let total = 0;
  for (const reg of eligible) {
    const commission = commissions.calculateCommission(reg);
    store.insert("payout_line_items", {
      id: newId("payoutitem"), payoutId: payout.id, registrationId: reg.id,
      grossAmountCents: commission.grossCourseRevenueCents,
      rateApplied: commission.ratePercent,
      netAmountCents: commission.commissionCents,
    });
    total += commission.commissionCents;
  }
  store.update("payouts", payout.id, { totalAmountCents: total });

  return { created: true, payout: store.findOne("payouts", (p) => p.id === payout.id) };
}

module.exports = { generatePayout, eligibleRegistrationsFor };

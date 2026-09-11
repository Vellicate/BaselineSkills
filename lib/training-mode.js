// Normalizes the free-text session "mode" values actually stored today
// ("Live Online", "Classroom", "Corporate") into the three
// canonical training-mode categories this site now standardizes on: Live,
// Recorded, Hybrid. Every current session is instructor-led in some form
// (this business doesn't yet sell pre-recorded, self-paced content), so
// anything not explicitly flagged Recorded or Hybrid maps to Live rather
// than guessed at — a real, checkable default, not an arbitrary one.
function trainingModeCategory(rawMode) {
  const m = (rawMode || "").toLowerCase();
  if (m.includes("hybrid")) return "Hybrid";
  if (m.includes("recorded") || m.includes("self-paced") || m.includes("self paced")) return "Recorded";
  return "Live";
}

// Short descriptions — for course cards, where space is tight.
const SHORT_DESCRIPTIONS = {
  Live: "Instructor-led. Interactive. Real-time.",
  Recorded: "Self-paced. Flexible. Learn anytime.",
  Hybrid: "Self-paced learning + live interaction.",
};

// Long descriptions — for the homepage FAQ / "How you'll learn" section only.
const LONG_DESCRIPTIONS = {
  Live: "Learn with a practitioner in real time. Ask questions, practise with examples and get feedback.",
  Recorded: "Learn at your own pace with recorded lessons and supporting materials.",
  Hybrid: "Combine self-paced learning with live sessions for the best of both worlds.",
};

const SYMBOLS = { Live: "🔴", Recorded: "▶", Hybrid: "↔" };

function trainingModeShort(rawMode) {
  return SHORT_DESCRIPTIONS[trainingModeCategory(rawMode)];
}

module.exports = { trainingModeCategory, trainingModeShort, SHORT_DESCRIPTIONS, LONG_DESCRIPTIONS, SYMBOLS };

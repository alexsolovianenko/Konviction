const small =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const tens = "x x twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function spokenNumber(value) {
  if (/^\d+(?:\.\d{1,2})?$/.test(value)) return Number(value);
  const [first, second, ...rest] = value.replaceAll("-", " ").split(" ");
  if (rest.length) return null;
  if (!second && small.includes(first)) return small.indexOf(first);
  const n = tens.indexOf(first);
  if (n >= 2 && (!second || (small.indexOf(second) > 0 && small.indexOf(second) <= 9)))
    return 10 * n + (second ? small.indexOf(second) : 0);
  if (first === "one" && second === "hundred") return 100;
  return null;
}

export function orderSize(input, defaultUnit) {
  const match = /^(\$)?([\w .-]+?)(?: (dollars?|contracts?))?$/.exec(input);
  if (!match) return null;
  const n = spokenNumber(match[2]);
  const unit = match[1] ? "dollars" : (match[3] ?? defaultUnit);
  if (!(n > 0) || !unit || (match[1] && match[3]?.startsWith("contract"))) return null;
  if (unit.startsWith("dollar")) return { budget_usd: n };
  return Number.isSafeInteger(n) ? { quantity: n } : null;
}

export function safeName(value, ids) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 180 ||
    ids.some((id) => id && value.toLowerCase().includes(id.toLowerCase())) ||
    /GEMI-|\b[A-Z]+05M\d/i.test(value)
  )
    return null;
  return value.trim();
}

export function executionSpeech(result) {
  switch (result.outcome_summary) {
    case "FILLED":
      return `Filled ${result.filled_quantity} sandbox contracts.`;
    case "PARTIAL":
      return `Partly filled, ${result.filled_quantity} sandbox contracts.`;
    case "NOT_FILLED":
      return "Gemini reports zero contracts filled.";
    case "EXCHANGE_REJECTED":
      return "Gemini rejected the order.";
    case "PENDING_UNKNOWN":
      return "Gemini has not confirmed the result. Check your order history before placing another order.";
    default:
      return "The quote could not be executed.";
  }
}

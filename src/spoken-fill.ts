// Use only exchange-reported quantities and average execution prices in the spoken receipt.
export function spokenFill(
  outcome: string,
  filled: number | string | null | undefined,
  requested: number | string,
  average: number | string | null | undefined,
): string | undefined {
  const qty = Number(filled);
  const total = Number(requested);
  const known = filled != null && String(filled).trim() !== "" && qty > 0 && qty <= total;
  const price = Number(average);
  const cents = Number((price * 100).toFixed(2));
  const at = price > 0 && price < 1 ? ` at ${cents} ${cents === 1 ? "cent" : "cents"}` : "";
  if (outcome === "FILLED" && known && qty === total) return `Filled ${qty}${at}.`;
  if (outcome === "PARTIAL" && known && qty < total) return `Filled ${qty} of ${total}${at}.`;
  if (outcome === "OPEN" && known && qty < total) return `Filled ${qty}${at}. Remainder open.`;
  return undefined;
}

/** Filled dollars are execution notional. Gemini's REST order response does not report charged fees. */
export function spokenBudgetFill(
  terms: {budget_usd?: number | string; limit_price: number | string},
  outcome: string,
  filled: number | string | null | undefined,
  average: number | string | null | undefined,
): string | undefined {
  const budget = Number(terms.budget_usd);
  if (!(budget > 0)) return;
  if (outcome === "PENDING_UNKNOWN") return "Final fill unconfirmed.";
  if (outcome === "NOT_FILLED") return "Nothing filled at your price.";
  const price = Number(average);
  const qty = Number(filled);
  if (outcome === "OPEN" && filled != null && qty === 0)
    return "Your order is waiting at " + Math.round(Number(terms.limit_price) * 100) + " cents.";
  if (!(qty > 0 && price > 0 && price <= Number(terms.limit_price) + 1e-9)) return;
  const dollars = "$" + (qty * price).toFixed(2);
  if (outcome === "FILLED") return dollars + " filled before fees.";
  if (outcome === "PARTIAL") return dollars + " of $" + budget.toFixed(2) + " filled before fees. The rest was cancelled.";
  if (outcome === "OPEN") return dollars + " filled before fees. The rest is waiting.";
  return undefined;
}

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

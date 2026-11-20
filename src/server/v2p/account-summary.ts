import { marketTitle } from "./market-title";
import { geminiReadError, getUsdAvailable, gPrivate, hasCredentials } from "./gemini";
import { num } from "./util";

let live: { at: number; value: Record<string, unknown> } | null = null;

async function refreshAccount() {
  if (live && Date.now() - live.at < 5000) return live.value;
  if (!hasCredentials()) {
    live = { at: Date.now(), value: { configured: false } };
    return live.value;
  }
  const [terms, bal, pos] = await Promise.all([
    gPrivate("/v1/prediction-markets/terms/status", {}, { method: "GET" }),
    getUsdAvailable(),
    gPrivate("/v1/prediction-markets/positions"),
  ]);
  // deno-lint-ignore no-explicit-any
  const rows = pos.data?.positions;
  const validPositions = pos.ok && Array.isArray(rows) && rows.every((p: any) =>
    typeof p?.symbol === "string" && p.symbol && ["number", "string"].includes(typeof p.totalQuantity) && num(p.totalQuantity) !== null);
  const positions = (validPositions ? rows : []).filter((p: any) => (num(p.totalQuantity) ?? 0) > 0).map((p: any) => ({
    symbol: p.symbol, outcome: p.outcome, quantity: p.totalQuantity, on_hold: p.quantityOnHold, avg_price: p.avgPrice,
    bid: p.prices?.sell?.[String(p.outcome).toLowerCase()] ?? null, market_value: p.marketValue ?? null,
    unrealized_pnl: p.unrealizedPnl ?? null, event: marketTitle(p.contractMetadata?.eventName, p.contractMetadata?.expiryDate), contract: marketTitle(p.contractMetadata?.contractName, p.contractMetadata?.expiryDate),
    contract_status: p.contractMetadata?.contractStatus, expiry: p.contractMetadata?.expiryDate, resolution_side: p.resolutionSide ?? null,
  }));
  live = {
    at: Date.now(),
    value: {
      configured: true,
      terms_accepted: terms.ok && typeof terms.data?.hasAcceptedLatest === "boolean" ? terms.data.hasAcceptedLatest : null,
      terms_error: !terms.ok ? geminiReadError(terms) : typeof terms.data?.hasAcceptedLatest !== "boolean" ? "Gemini returned an unexpected terms response." : null,
      usd_available: bal.usd,
      balance_error: bal.error ?? null,
      positions,
      positions_error: !pos.ok ? geminiReadError(pos) : validPositions ? null : "Gemini returned an unexpected positions response.",

    },
  };
  return live.value;
}

let pending: ReturnType<typeof refreshAccount> | undefined;
export function liveAccount() {
  pending ??= refreshAccount().finally(() => { pending = undefined; });
  return pending;
}

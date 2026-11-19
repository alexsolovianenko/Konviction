// Browser client for /api/public/browser-trading/* (adapted from alex's src/browserTrading.ts,
// which targeted a local Node/SQLite server at /api/trading/*).
export type Availability = { execution_enabled: boolean; message: string };
export type Proposal = {
  proposal_id: string;
  title: string;
  contract_label: string;
  instrument_symbol: string;
  outcome: string;
  quantity: number;
  limit_price: number;
  quote_price: number;
  est_fee_usd: number;
  notional_usd: number;
  expires_at: string;
  readback: string;
};
export const PIN_PATTERN = /^\d{4,8}$/;

export async function tradingRequest(
  path: "availability" | "session" | "proposals" | "approve" | "end" | "portfolio",
  body?: object,
  token?: string,
  options: { keepalive?: boolean } = {},
) {
  try {
    const response = await fetch("/api/public/browser-trading/" + path, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      keepalive: options.keepalive,
      headers: {
        ...(body && { "Content-Type": "application/json" }),
        ...(token && { Authorization: "Bearer " + token }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === "approve" ? 30000 : 18000),
    });
    const result = await response.json();
    if (typeof result?.ok === "boolean") return { ...result, message: result.message ?? result.error?.message };
  } catch {
    /* Return a bounded message for network or deployment failures. */
  }
  return {
    ok: false,
    message:
      path === "approve"
        ? "Approval result unavailable. Check open trades before trying again."
        : "Sandbox trading service unavailable.",
  };
}

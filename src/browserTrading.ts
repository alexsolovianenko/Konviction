// Browser client for /api/public/browser-trading/* (adapted from alex's src/browserTrading.ts,
// which targeted a local Node/SQLite server at /api/trading/*).
export type Availability = {
  execution_enabled: boolean;
  message: string;
  voice_confirmation_supported?: boolean;
  voice_authorized?: boolean;
  call_confirmation_supported?: boolean;
};
export type Proposal = {
  proposal_id: string;
  side?: "buy" | "sell";
  order_mode?: "market" | "limit";
  title: string;
  contract_label: string;
  event_ticker?: string;
  instrument_symbol: string;
  outcome: string;
  quantity: number;
  limit_price: number;
  quote_price: number | null;
  est_fee_usd: number;
  notional_usd: number;
  expires_at: string;
  confirmationDeadline?: number;
  readback: string;
  voice_readback?: string;
};
export const workerTrading = import.meta.env["VITE_WORKER_TRADING"] === true;

export async function tradingRequest(
  path: "build-combo" | "availability" | "session" | "proposals" | "dismiss-proposal" | "order-result" | "end" | "portfolio" | "pair" | "voice-confirm",
  body?: object,
  token?: string,
  options: { keepalive?: boolean; idempotencyKey?: string } = {},
) {
  try {
    const response = await fetch((workerTrading ? "/api/public/browser-trading/" : "/api/trading/") + path, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      keepalive: options.keepalive ?? false,
      headers: {
        ...(body && { "Content-Type": "application/json" }),
        ...(options.idempotencyKey && { "Idempotency-Key": options.idempotencyKey }),
        ...(token && { Authorization: "Bearer " + token }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout((path === "voice-confirm") ? 30000 : 18000),
    });
    const receivedAt = performance.now();
    const serverNow = Date.parse(response.headers.get("date") ?? "");
    const result = await response.json();
    if (path === "proposals" && result?.proposal) {
      const expiresAt = Date.parse(result.proposal.expires_at);
      if (Number.isFinite(expiresAt)) {
        result.proposal.confirmationDeadline = receivedAt + expiresAt - (Number.isFinite(serverNow) ? serverNow : Date.now());
      }
    }
    if (typeof result?.ok === "boolean") return { ...result, message: result.message ?? result.error?.message };
  } catch {
    /* Return a bounded message for network or deployment failures. */
  }
  return {
    ok: false,
    message:
      (path === "voice-confirm")
        ? "Approval result unavailable. Check open trades before trying again."
        : "Sandbox trading service unavailable.",
  };
}

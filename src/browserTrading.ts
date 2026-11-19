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
export async function tradingRequest(path: string, body?: object, token?: string, key?: string) {
  try {
    const response = await fetch("/api/trading/" + path, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: {
        ...(body && { "Content-Type": "application/json" }),
        ...(token && { Authorization: "Bearer " + token }),
        ...(key && { "Idempotency-Key": key }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(18000),
    });
    const result = await response.json();
    if (typeof result?.ok === "boolean")
      return { ...result, message: result.message ?? result.error?.message };
  } catch {
    /* Return a bounded message for network or deployment failures. */
  }
  return {
    ok: false,
    message:
      path === "approve"
        ? "Approval result unavailable. Check open trades before trying again."
        : "Local sandbox trading service unavailable.",
  };
}

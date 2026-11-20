// x402 v2 header parsing and requirement validation. Pure functions, no network, no signing.
import type { ResearchConfig } from "./config";

export type PaymentRequirement = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: string };
};

export type PaymentRequired = {
  x402Version: number;
  accepts: PaymentRequirement[];
  resource?: { url?: string; description?: string };
};

export type SettlementResponse = {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
};

const b64decode = (s: string): string => {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(norm), (c) => c.charCodeAt(0)));
};
export const b64encodeJson = (v: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Reads the requirement from PAYMENT-REQUIRED (v2), falling back to X-PAYMENT-REQUIRED or a JSON body. */
export function parsePaymentRequired(headers: Headers, bodyText: string): PaymentRequired | null {
  for (const name of ["payment-required", "x-payment-required"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      const v = JSON.parse(b64decode(h));
      if (isPaymentRequired(v)) return v;
    } catch {
      /* try next */
    }
  }
  try {
    const v = JSON.parse(bodyText);
    if (isPaymentRequired(v)) return v;
  } catch {
    /* not json */
  }
  return null;
}

function isPaymentRequired(v: unknown): v is PaymentRequired {
  const o = v as PaymentRequired;
  return Boolean(o) && typeof o.x402Version === "number" && Array.isArray(o.accepts);
}

export function parseSettlementResponse(headers: Headers): SettlementResponse | null {
  for (const name of ["payment-response", "x-payment-response"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      return JSON.parse(b64decode(h)) as SettlementResponse;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export type Validation =
  { ok: true; requirement: PaymentRequirement } | { ok: false; reason: string };

/** Picks the first offer that passes every allowlist and cap. Refuses everything else. */
export function selectRequirement(pr: PaymentRequired, cfg: ResearchConfig): Validation {
  if (pr.x402Version !== 2)
    return { ok: false, reason: `Unsupported x402 version ${pr.x402Version}.` };
  const reasons: string[] = [];
  for (const r of pr.accepts) {
    const why = rejectReason(r, cfg);
    if (!why) return { ok: true, requirement: r };
    reasons.push(why);
  }
  return { ok: false, reason: reasons[0] ?? "No payment options offered." };
}

/** Null when the requirement passes every allowlist and cap, otherwise the reason it is refused. */
export function rejectReason(r: PaymentRequirement, cfg: ResearchConfig): string | null {
  if (r.scheme !== "exact") return `Scheme ${r.scheme} not allowed.`;
  if (!cfg.networks.includes(r.network)) return `Network ${r.network} not allowed.`;
  if (String(r.asset).toLowerCase() !== cfg.asset) return `Asset ${r.asset} not allowed.`;
  if (!cfg.payTo.includes(String(r.payTo).toLowerCase()))
    return `Recipient ${r.payTo} not allowed.`;
  if (!/^\d+$/.test(String(r.amount))) return "Malformed amount.";
  const amt = BigInt(r.amount);
  if (amt <= 0n) return "Zero amount.";
  if (amt > cfg.maxPerCallAtomic)
    return `Price ${r.amount} exceeds per-call cap ${cfg.maxPerCallAtomic}.`;
  if (!r.extra || r.extra.name !== "USDC" || !r.extra.version)
    return "Missing EIP-712 domain for USDC.";
  if (r.extra.assetTransferMethod && r.extra.assetTransferMethod !== "eip3009")
    return "Only EIP-3009 transfers are allowed.";
  return null;
}

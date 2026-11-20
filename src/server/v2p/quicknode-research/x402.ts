// x402 v2 parsing and validation for the fixed QuickNode Solana resource. Pure functions; no wallet.
import type { ResearchConfig } from "./config";
import { GATEWAY_BATCH_NAME } from "./config";

export type Requirement = {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number | null;
  extra: { name: string | null; version: string | null; verifyingContract: string | null };
};

export class QuoteRejected extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

function decodeBase64Json(value: string): unknown {
  if (value.length > 64_000 || !/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error("bad base64");
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function toRequirement(raw: unknown): Requirement | null {
  if (!isObj(raw)) return null;
  const extra = isObj(raw["extra"]) ? raw["extra"] : {};
  const scheme = str(raw["scheme"]);
  const network = str(raw["network"]);
  const amount = str(raw["amount"]);
  const payTo = str(raw["payTo"]);
  const asset = str(raw["asset"]);
  if (!scheme || !network || !amount || !payTo || !asset || !/^\d{1,30}$/.test(amount)) return null;
  const timeout = raw["maxTimeoutSeconds"];
  return {
    scheme,
    network,
    amount,
    payTo,
    asset,
    maxTimeoutSeconds: typeof timeout === "number" && Number.isFinite(timeout) ? timeout : null,
    extra: {
      name: str(extra["name"]),
      version: str(extra["version"]),
      verifyingContract: str(extra["verifyingContract"]),
    },
  };
}

/**
 * Read PaymentRequired from an unpaid 402: the PAYMENT-REQUIRED header (x402 v2), falling back to
 * the JSON body QuickNode also returns. Returns the resource URL and every well-formed accept.
 */
export function parsePaymentRequired(
  headerValue: string | null,
  bodyText: string,
): { resourceUrl: string | null; accepts: Requirement[] } {
  let doc: unknown = null;
  if (headerValue) {
    try {
      doc = decodeBase64Json(headerValue.trim());
    } catch {
      doc = null;
    }
  }
  if (!isObj(doc)) {
    try {
      doc = JSON.parse(bodyText);
    } catch {
      doc = null;
    }
  }
  if (!isObj(doc) || doc["x402Version"] !== 2 || !Array.isArray(doc["accepts"]))
    throw new QuoteRejected("BAD_402", "The provider's payment request was not understood.");
  const resource = isObj(doc["resource"]) ? str(doc["resource"]["url"]) : null;
  return {
    resourceUrl: resource,
    accepts: doc["accepts"].map(toRequirement).filter((r): r is Requirement => r !== null),
  };
}

export const isBatch = (r: Requirement) =>
  r.extra.name === GATEWAY_BATCH_NAME && r.extra.version === "1";

/**
 * Mirror of @quicknode/x402's nanopayment policy: among accepts on our network, take the cheapest
 * Gateway-batched one, else the cheapest. We validate what the SDK would actually sign.
 */
export function selectLikeSdk(accepts: Requirement[], network: string): Requirement | null {
  const forNetwork = accepts.filter((r) => r.network === network);
  const batch = forNetwork.filter(isBatch);
  const pool = batch.length ? batch : forNetwork;
  return (
    [...pool].sort((a, b) =>
      BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0,
    )[0] ?? null
  );
}

/** Throws QuoteRejected unless `r` is exactly the kind of payment this feature may make. */
export function validateRequirement(
  r: Requirement | null,
  cfg: ResearchConfig,
  resourceUrl: string | null,
  expectedUrl: string | null,
): Requirement {
  // expectedUrl === null only inside the SDK policy, where the request URL is already fixed.
  if (
    expectedUrl !== null &&
    resourceUrl !== null &&
    resourceUrl.replace(/\/$/, "") !== expectedUrl
  )
    throw new QuoteRejected("WRONG_RESOURCE", "The payment request names a different resource.");
  if (!r)
    throw new QuoteRejected("WRONG_NETWORK", "The provider offered no Arc Testnet payment option.");
  if (r.network !== cfg.network)
    throw new QuoteRejected("WRONG_NETWORK", "Payment must be on Arc Testnet.");
  if (r.scheme !== "exact") throw new QuoteRejected("WRONG_SCHEME", "Unsupported payment scheme.");
  if (r.asset.toLowerCase() !== cfg.asset.toLowerCase())
    throw new QuoteRejected("WRONG_TOKEN", "Payment token is not Arc Testnet USDC.");
  if (!cfg.payTo.includes(r.payTo.toLowerCase()))
    throw new QuoteRejected("UNEXPECTED_PAYEE", "Payment recipient is not allowlisted.");
  if (!isBatch(r))
    throw new QuoteRejected("NOT_NANOPAYMENT", "Only Circle Gateway nanopayments are allowed.");
  if (
    !r.extra.verifyingContract ||
    !cfg.gatewayVerifiers.includes(r.extra.verifyingContract.toLowerCase())
  )
    throw new QuoteRejected("UNEXPECTED_VERIFIER", "Gateway contract is not allowlisted.");
  const amount = BigInt(r.amount);
  if (amount <= 0n) throw new QuoteRejected("BAD_PRICE", "Quoted price is invalid.");
  if (amount > cfg.maxPerRequest)
    throw new QuoteRejected("OVER_CAP", "Quoted price exceeds the per-request cap.");
  return r;
}

/** Same requirement terms (the SDK may get a fresh 402; we only sign identical or cheaper terms). */
export function sameTerms(a: Requirement, quoted: Requirement): boolean {
  return (
    a.network === quoted.network &&
    a.scheme === quoted.scheme &&
    a.asset.toLowerCase() === quoted.asset.toLowerCase() &&
    a.payTo.toLowerCase() === quoted.payTo.toLowerCase() &&
    (a.extra.verifyingContract ?? "").toLowerCase() ===
      (quoted.extra.verifyingContract ?? "").toLowerCase() &&
    BigInt(a.amount) <= BigInt(quoted.amount)
  );
}

/** Client-safe fields of a decoded PAYMENT-RESPONSE header. Session JWTs and signatures are dropped. */
export function decodePaymentResponse(
  value: string | null,
): Record<string, string | boolean | null> | null {
  if (!value) return null;
  try {
    const d = decodeBase64Json(value.trim());
    if (!isObj(d)) return null;
    const pick = (k: string) => {
      const v = d[k];
      return typeof v === "string" ? v.slice(0, 200) : typeof v === "boolean" ? v : null;
    };
    return {
      success: pick("success"),
      network: pick("network"),
      payer: pick("payer"),
      // For Gateway-batched payments this is a provider reference, not a per-request on-chain settlement.
      provider_reference: pick("transaction"),
      error_reason: pick("errorReason"),
    };
  } catch {
    return { undecodable: true };
  }
}

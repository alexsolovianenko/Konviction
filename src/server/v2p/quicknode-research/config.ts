// QuickNode x402 crypto research: fixed origin, fixed per-chain methods, Arc Testnet nanopayments only.
// SERVER ONLY. This module never imports the Gemini trade engine and never accepts a URL,
// RPC method or RPC body from a caller (routes.ts holds the only allowed paths and bodies).
import { env } from "../util";

/** The only origin this feature may contact for paid data. */
export const QUICKNODE_BASE_URL = "https://x402.quicknode.com";
/** Free list of networks QuickNode x402 currently serves (no payment, no credentials). */
export const QUICKNODE_NETWORKS_URL = "https://x402.quicknode.com/networks";

/** Arc Testnet (CAIP-2) and its USDC (6 decimals, ERC-20 interface). */
export const ARC_TESTNET = "eip155:5042002";
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
/** Circle Gateway batching marker used by QuickNode's nanopayment requirement. */
export const GATEWAY_BATCH_NAME = "GatewayWalletBatched";

/**
 * Values observed in QuickNode's unpaid 402 response for eip155:5042002 on 2026-11-20.
 * The recipient and Gateway verifier are allowlisted; env can replace the lists (e.g. if QuickNode
 * rotates its address) but never widens chain, asset or price limits.
 */
export const DEFAULT_PAYTO = ["0xf46394addda95a3d5bcc1124605e3d15d204623c"];
export const DEFAULT_GATEWAY_VERIFIERS = ["0x0077777d7eba4688bdef3e311b846f25870a19b9"];

/** Hard ceilings in atomic USDC (6 decimals). Env may lower them, never raise them. */
export const HARD_MAX_PER_REQUEST = 10_000n; // 0.01 USDC
export const HARD_MAX_PER_SESSION = 100_000n; // 0.10 USDC
export const HARD_MAX_PER_DAY = 250_000n; // 0.25 USDC
export const QUOTE_TTL_MS = 4 * 60 * 1000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const lowerCap = (name: string, hard: bigint): bigint => {
  const raw = env(name);
  if (!raw || !/^\d{1,18}$/.test(raw)) return hard;
  const v = BigInt(raw);
  return v < hard ? v : hard;
};

const addressList = (name: string, fallback: string[]): string[] => {
  const raw = env(name);
  if (!raw) return fallback;
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ADDRESS.test(s));
  return list.length ? list : fallback;
};

export type ResearchConfig = {
  network: string;
  asset: string;
  payTo: string[];
  gatewayVerifiers: string[];
  maxPerRequest: bigint;
  maxPerSession: bigint;
  maxPerDay: bigint;
  quoteTtlMs: number;
  /** Spending is off unless QUICKNODE_RESEARCH_PAYMENTS is exactly "true". */
  paymentsEnabled: boolean;
  /** Public address of the dedicated research wallet. The server key must derive to it. */
  expectedSender: string | null;
};

export function researchConfig(): ResearchConfig {
  const sender = (env("QUICKNODE_RESEARCH_WALLET_ADDRESS") ?? "").trim().toLowerCase();
  return {
    network: ARC_TESTNET,
    asset: ARC_TESTNET_USDC,
    payTo: addressList("QUICKNODE_X402_PAYTO", DEFAULT_PAYTO),
    gatewayVerifiers: addressList("QUICKNODE_X402_GATEWAY_VERIFIERS", DEFAULT_GATEWAY_VERIFIERS),
    maxPerRequest: lowerCap("QUICKNODE_RESEARCH_MAX_PER_REQUEST_ATOMIC", HARD_MAX_PER_REQUEST),
    maxPerSession: lowerCap("QUICKNODE_RESEARCH_MAX_PER_SESSION_ATOMIC", HARD_MAX_PER_SESSION),
    maxPerDay: lowerCap("QUICKNODE_RESEARCH_MAX_PER_DAY_ATOMIC", HARD_MAX_PER_DAY),
    quoteTtlMs: QUOTE_TTL_MS,
    paymentsEnabled: env("QUICKNODE_RESEARCH_PAYMENTS") === "true",
    expectedSender: ADDRESS.test(sender) ? sender : null,
  };
}

/** Atomic USDC (6 decimals) as a plain decimal string, e.g. 100n -> "0.0001". */
export function formatUsdc(atomic: bigint | string): string {
  const n = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (
    (neg ? "-" : "") + whole.toString() + "." + (frac.length >= 2 ? frac : frac.padEnd(2, "0"))
  );
}

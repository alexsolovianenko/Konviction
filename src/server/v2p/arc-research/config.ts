// Arc research purchase limits and allowlists.
// This module buys market data only. It never imports or calls the Gemini trade engine.
import { env } from "../util";

/** USDC on Arc (native gas token exposed through an ERC-20 interface, 6 decimals). */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const ARC_MAINNET = "eip155:5042";
export const ARC_TESTNET = "eip155:5042002";

export const DEFAULT_RESEARCH_URL = "https://arc.blockrun.ai/api/v1/pm/markets/search";
/** BlockRun's payTo, as returned by the live unpaid 402 probe on 2026-11-19. */
export const DEFAULT_PAYTO = "0x634D274e67DafaF76C54153aa113906a606e1E0B";

/** Explicit provider allowlist. The research URL must be HTTPS on one of these hosts, whatever env says. */
export const PROVIDER_HOSTS = ["arc.blockrun.ai"];
export function providerAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && PROVIDER_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

const RPC_DEFAULTS: Record<string, string> = {
  [ARC_MAINNET]: "https://rpc.mainnet.arc.io",
  [ARC_TESTNET]: "https://rpc.testnet.arc.io",
};
const EXPLORER_DEFAULTS: Record<string, string> = {
  [ARC_MAINNET]: "https://explorer.arc.io/tx/",
  [ARC_TESTNET]: "https://testnet.arcscan.app/tx/",
};

const bigintEnv = (name: string, fallback: bigint): bigint => {
  const v = env(name);
  if (!v || !/^\d+$/.test(v)) return fallback;
  return BigInt(v);
};

export type ResearchConfig = {
  url: string;
  networks: string[];
  asset: string;
  payTo: string[];
  maxPerCallAtomic: bigint;
  maxPerDayAtomic: bigint;
  rpcUrl: (network: string) => string | null;
  explorerTx: (network: string, hash: string) => string | null;
  /** Spending is off unless ARC_RESEARCH_PAYMENTS=true (and the wallet key is set). */
  paymentsEnabled: boolean;
};

export function researchConfig(): ResearchConfig {
  const networks = (env("ARC_NETWORKS") ?? ARC_MAINNET)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const payTo = (env("ARC_RESEARCH_PAYTO") ?? DEFAULT_PAYTO)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    url: env("ARC_RESEARCH_URL") ?? DEFAULT_RESEARCH_URL,
    networks,
    asset: ARC_USDC.toLowerCase(),
    payTo,
    // Hard ceilings in code: $0.01 per call and $0.25 per UTC day, regardless of env.
    maxPerCallAtomic: min(bigintEnv("ARC_MAX_PER_CALL_ATOMIC", 10_000n), 10_000n),
    maxPerDayAtomic: min(bigintEnv("ARC_MAX_PER_DAY_ATOMIC", 250_000n), 250_000n),
    rpcUrl: (network) =>
      (network === ARC_MAINNET ? env("ARC_RPC_URL") : env("ARC_TESTNET_RPC_URL")) ??
      RPC_DEFAULTS[network] ??
      null,
    explorerTx: (network, hash) => {
      const base = EXPLORER_DEFAULTS[network];
      return base && /^0x[0-9a-fA-F]{64}$/.test(hash) ? base + hash : null;
    },
    // The wallet itself is checked separately (wallet.ts); without it approval still refuses.
    paymentsEnabled: env("ARC_RESEARCH_PAYMENTS") === "true",
  };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export const chainIdOf = (network: string): number | null => {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : null;
};

export const formatUsdcAtomic = (atomic: bigint | string): string => {
  const n = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return "$" + whole.toString() + (frac ? "." + frac.padEnd(2, "0") : ".00");
};

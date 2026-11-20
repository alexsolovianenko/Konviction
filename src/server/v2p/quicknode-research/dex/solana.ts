// Native Solana swaps on one verified Orca Whirlpool SOL/stablecoin pool, decoded from each
// transaction's vault token-balance changes (pre/post token balances in executed-transaction meta).
// Pool verified on 2026-11-20 via getAccountInfo: owner is the Whirlpool program
// whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc, token_mint_a = wrapped SOL, token_mint_b = USDT, and
// the vault addresses below are the account's token_vault_a / token_vault_b.
import type { PoolRef, ReportInput } from "./report";
import { pool, RpcFailure, type Rpc } from "./rpc";
import { TIMEFRAME_SECONDS, units, type SwapLeg, type Timeframe } from "./volume";

export const SOL_POOL = {
  address: "FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC",
  pair: "SOL/USDT 0.02%",
  dex: "Orca Whirlpool",
  assetMint: "So11111111111111111111111111111111111111112",
  assetVault: "BFAWVmF5aoALggQ9Y2RpTijpYKRESxcdNe6JDNZEpoxC",
  assetDecimals: 9,
  stableMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  stableVault: "B1qD7GDsKN4kz2ehks71eEpVhUzqaTVXaWfCxXykRAA9",
  stableDecimals: 6,
};

/** Signature pages (1000 each) and transaction decodes allowed per request. */
export const SIG_PAGES: Record<Timeframe, number> = { "5m": 1, "15m": 1, "1h": 2, "24h": 3 };
export const DECODE_BUDGET = 75;
export const solMaxCalls = (tf: Timeframe) => SIG_PAGES[tf] + DECODE_BUDGET;

const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const TX_OPTS = { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" };

export function solAllowed(method: string, params: unknown): boolean {
  if (!Array.isArray(params) || params.length !== 2) return false;
  const o = params[1] as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  if (method === "getSignaturesForAddress") {
    if (params[0] !== SOL_POOL.address || o["limit"] !== 1000 || o["commitment"] !== "confirmed")
      return false;
    const keys = Object.keys(o).sort().join();
    return (
      keys === "commitment,limit" ||
      (keys === "before,commitment,limit" && SIG.test(String(o["before"])))
    );
  }
  if (method === "getTransaction")
    return (
      typeof params[0] === "string" &&
      SIG.test(params[0]) &&
      JSON.stringify(o) === JSON.stringify(TX_OPTS)
    );
  return false;
}

type Sig = { signature: string; blockTime: number | null; err: unknown };
type Tx = Record<string, unknown>;

const keyList = (tx: Tx): string[] => {
  const msg = ((tx["transaction"] ?? {}) as Record<string, unknown>)["message"] as
    Record<string, unknown> | undefined;
  const raw = Array.isArray(msg?.["accountKeys"]) ? (msg!["accountKeys"] as unknown[]) : [];
  const keys = raw.map((k) =>
    typeof k === "string" ? k : String((k as Record<string, unknown>)?.["pubkey"] ?? ""),
  );
  const loaded = ((tx["meta"] ?? {}) as Record<string, unknown>)["loadedAddresses"] as
    Record<string, unknown> | undefined;
  for (const part of ["writable", "readonly"])
    if (Array.isArray(loaded?.[part])) keys.push(...(loaded![part] as string[]).map(String));
  return keys;
};

/** Raw token amount of `vault` (with `mint` and `decimals`) in a balance list, or null. */
function vaultAmount(list: unknown, keys: string[], vault: string, mint: string, decimals: number) {
  if (!Array.isArray(list)) return null;
  for (const b of list as Array<Record<string, unknown>>) {
    const idx = b?.["accountIndex"];
    if (typeof idx !== "number" || keys[idx] !== vault) continue;
    const ui = (b["uiTokenAmount"] ?? {}) as Record<string, unknown>;
    if (
      b["mint"] !== mint ||
      ui["decimals"] !== decimals ||
      typeof ui["amount"] !== "string" ||
      !/^\d{1,30}$/.test(ui["amount"])
    )
      return null;
    return BigInt(ui["amount"]);
  }
  return null;
}

/**
 * Decode one executed transaction into a pool swap leg. Only a transaction where the SOL vault and
 * the stablecoin vault move in OPPOSITE directions is a swap; liquidity adds/removes (same
 * direction), fee collection and untouched vaults are ignored.
 */
export function decodeSolanaTx(sig: string, tx: Tx | null): SwapLeg | null {
  if (!tx) return null;
  const meta = (tx["meta"] ?? null) as Record<string, unknown> | null;
  if (!meta || meta["err"] !== null) return null;
  const time = tx["blockTime"];
  if (typeof time !== "number") return null;
  const keys = keyList(tx);
  const P = SOL_POOL;
  const a0 = vaultAmount(
    meta["preTokenBalances"],
    keys,
    P.assetVault,
    P.assetMint,
    P.assetDecimals,
  );
  const a1 = vaultAmount(
    meta["postTokenBalances"],
    keys,
    P.assetVault,
    P.assetMint,
    P.assetDecimals,
  );
  const s0 = vaultAmount(
    meta["preTokenBalances"],
    keys,
    P.stableVault,
    P.stableMint,
    P.stableDecimals,
  );
  const s1 = vaultAmount(
    meta["postTokenBalances"],
    keys,
    P.stableVault,
    P.stableMint,
    P.stableDecimals,
  );
  if (a0 === null || a1 === null || s0 === null || s1 === null) return null;
  const da = a1 - a0; // pool's SOL change
  const ds = s1 - s0; // pool's stablecoin change
  if (da === 0n || ds === 0n || da > 0n === ds > 0n) return null;
  return {
    tx: sig,
    leg: "pool",
    time,
    asset: -units(da, P.assetDecimals),
    usd: Math.abs(units(ds, P.stableDecimals)),
    pool: P.address,
  };
}

export async function runSolana(
  tf: Timeframe,
  rpc: Rpc,
  nowMs: number,
): Promise<Omit<ReportInput, "callsUsed" | "observedAt">> {
  const now = Math.floor(nowMs / 1000);
  const start = now - TIMEFRAME_SECONDS[tf];
  const P = SOL_POOL;
  const warnings: string[] = [];
  const pools: PoolRef[] = [
    {
      dex: P.dex,
      pair: P.pair,
      address: P.address,
      url: `https://solscan.io/account/${P.address}`,
    },
  ];
  const common = {
    asset: "SOL",
    assetNote: null,
    chain: "Solana",
    source: "QuickNode x402 solana-mainnet",
    method: "getSignaturesForAddress + getTransaction (vault balance changes)",
    timeframe: tf,
    pools,
    coverage: `One pool: ${P.dex} ${P.pair}. Other Solana pools, aggregator-only routes elsewhere and centralized exchanges are not included.`,
    txUrl: (h: string) => `https://solscan.io/tx/${h}`,
  };

  // 1. List the pool's signatures newest-first until the window start (bounded pages).
  const sigs: Sig[] = [];
  let reachedStart = false;
  let before: string | undefined;
  try {
    for (let page = 0; page < SIG_PAGES[tf]; page++) {
      const res = await rpc("getSignaturesForAddress", [
        P.address,
        before
          ? { limit: 1000, commitment: "confirmed", before }
          : { limit: 1000, commitment: "confirmed" },
      ]);
      if (!Array.isArray(res)) throw new RpcFailure("parse", "Signature list missing.");
      const list = (res as Array<Record<string, unknown>>).filter(
        (s) => typeof s?.["signature"] === "string" && SIG.test(s["signature"] as string),
      );
      if (list.length !== res.length)
        warnings.push(`${res.length - list.length} signature entries were malformed; the reported window may be incomplete.`);
      for (const s of list)
        sigs.push({
          signature: s["signature"] as string,
          blockTime: typeof s["blockTime"] === "number" ? s["blockTime"] : null,
          err: s["err"] ?? null,
        });
      const last = list.at(-1);
      if (
        res.length < 1000 ||
        (typeof last?.["blockTime"] === "number" && last["blockTime"] < start)
      ) {
        reachedStart = true;
        break;
      }
      before = last?.["signature"] as string;
    }
  } catch (e) {
    warnings.push(`Pool signature list unavailable: ${(e as Error).message}`);
  }
  if (!sigs.length)
    return { ...common, window: null, complete: false, legs: [], poolTxCount: null, warnings };
  const seen = new Set<string>();
  const unique = sigs.filter((s) =>
    seen.has(s.signature) ? false : (seen.add(s.signature), true),
  );
  const timed = unique.filter((s) => s.blockTime !== null) as Array<Sig & { blockTime: number }>;
  if (!timed.length)
    return {
      ...common,
      window: null,
      complete: false,
      legs: [],
      poolTxCount: null,
      warnings: [...warnings, "Solana transactions have no usable block timestamps; cannot establish a measured window."],
    };
  const missingTimes = unique.length - timed.length;
  if (missingTimes)
    warnings.push(`${missingTimes} pool transactions lacked timestamps and could not be included; coverage is partial.`);
  const inWindow = timed.filter((s) => s.blockTime >= start && s.err === null);
  const oldestFetched = Math.min(...timed.map((s) => s.blockTime));
  const knownFrom = reachedStart ? start : oldestFetched + 1;
  if (!reachedStart)
    warnings.push(
      `More than ${unique.length} pool transactions (including failed ones) in the window; the signature list was capped at ${SIG_PAGES[tf]} page(s) of 1000.`,
    );

  // 2. Decode the newest transactions (bounded budget), stopping at the first failure.
  const toDecode = inWindow.slice(0, DECODE_BUDGET);
  let failed = false;
  const results = await pool(
    toDecode,
    6,
    async (s) => {
      try {
        return (await rpc("getTransaction", [s.signature, TX_OPTS])) as Tx | null;
      } catch (e) {
        failed = true;
        throw e;
      }
    },
    () => failed,
  );
  let covered = 0;
  while (
    covered < results.length &&
    results[covered]?.ok &&
    (results[covered] as { value: Tx | null }).value
  )
    covered++;
  const legs: SwapLeg[] = [];
  let nonSwap = 0;
  for (let i = 0; i < covered; i++) {
    const leg = decodeSolanaTx(
      toDecode[i]!.signature,
      (results[i] as { ok: true; value: Tx }).value,
    );
    if (leg) legs.push(leg);
    else nonSwap++;
  }
  if (nonSwap)
    warnings.push(
      `${nonSwap} pool transactions were not swaps (liquidity, fees or no balance change) and were ignored.`,
    );
  if (covered < inWindow.length)
    warnings.push(
      `Decoded the newest ${covered} of ${inWindow.length}${reachedStart ? "" : "+"} successful pool transactions in the window (paid-call budget ${DECODE_BUDGET}).`,
    );
  if (failed) {
    const bad = results.find((r) => r && !r.ok) as { ok: false; error: unknown } | undefined;
    if (bad) warnings.push(`A transaction lookup failed: ${(bad.error as Error).message}`);
  }
  // Everything strictly newer than the first undecoded transaction is decoded.
  const from =
    covered < inWindow.length ? Math.max(knownFrom, inWindow[covered]!.blockTime + 1) : knownFrom;
  const nothingDecoded = toDecode.length > 0 && covered === 0;
  return {
    ...common,
    window: from < now && !nothingDecoded ? { from, to: now } : null,
    complete: reachedStart && missingTimes === 0 && covered === inWindow.length,
    legs,
    poolTxCount: reachedStart ? inWindow.length : null,
    warnings,
  };
}

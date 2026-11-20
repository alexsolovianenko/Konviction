// DEX buy vs sell volume for one asset, measured from the asset's perspective. Pure functions.
// A "swap leg" is one decoded, executed pool swap. Legs are deduplicated, filtered to the measured
// window, then netted per transaction so router hops and same-transaction round trips through
// several monitored pools are counted once (by their net effect on the asset).

export type Timeframe = "5m" | "15m" | "1h" | "24h";
export const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "24h"];
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "24h": 86400,
};
export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "5m": "5 minutes",
  "15m": "15 minutes",
  "1h": "1 hour",
  "24h": "24 hours",
};
export const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === "string" && (TIMEFRAMES as string[]).includes(v);

/** Gemini series like BTC05M, ETH15M, SOL1H; anything longer (daily, monthly) maps to 24h. */
export function timeframeForSeries(series: string | null, eventTicker = ""): Timeframe {
  const s = (series ?? "").toUpperCase();
  if (/05M$|\b5M$/.test(s) || /^[A-Z]{2,12}05M\d{10}$/.test(eventTicker)) return "5m";
  if (/15M$/.test(s) || /^[A-Z]{2,12}15M\d{10}$/.test(eventTicker)) return "15m";
  if (/1H$/.test(s)) return "1h";
  return "24h";
}

export type SwapLeg = {
  /** Transaction hash / signature. */
  tx: string;
  /** Unique id of this leg inside the transaction (log index, pool id). Used for de-duplication. */
  leg: string;
  /** Unix seconds when the transaction executed. */
  time: number;
  /** Asset amount the TRADER received (+) or paid (-), in whole asset units. */
  asset: number;
  /** Stablecoin value of the leg in USD (absolute, stablecoins at $1 face value). */
  usd: number;
  pool: string;
};

export type Trade = { tx: string; time: number; side: "buy" | "sell"; usd: number; asset: number };

export type Completeness = "complete" | "partial" | "unavailable";

export type VolumeTotals = {
  buy_usd: number;
  sell_usd: number;
  net_buy_usd: number;
  /** Buy share of total (buy + sell) USD volume, null when there was no volume. */
  buy_pct: number | null;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  /** Transactions whose buy and sell legs cancelled exactly (pure pass-through). */
  passthrough_count: number;
  /** Transactions with contradictory net token and quote movements, excluded conservatively. */
  inconsistent_count: number;
  last_trade_at: number | null;
  examples: Trade[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Aggregate legs inside [from, to] (unix seconds, inclusive). Legs with non-finite or zero values,
 * duplicate (tx, leg) pairs, and legs outside the window are dropped.
 */
export function aggregate(legs: SwapLeg[], from: number, to: number, examples = 5): VolumeTotals {
  const seen = new Set<string>();
  const byTx = new Map<string, { time: number; buyUsd: number; sellUsd: number; asset: number }>();
  for (const l of legs) {
    if (!Number.isFinite(l.usd) || !Number.isFinite(l.asset) || !Number.isFinite(l.time)) continue;
    if (l.usd <= 0 || l.asset === 0) continue;
    if (l.time < from || l.time > to) continue;
    const key = `${l.tx}#${l.leg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = byTx.get(l.tx) ?? { time: l.time, buyUsd: 0, sellUsd: 0, asset: 0 };
    if (l.asset > 0) t.buyUsd += l.usd;
    else t.sellUsd += l.usd;
    t.asset += l.asset;
    t.time = Math.max(t.time, l.time);
    byTx.set(l.tx, t);
  }
  const trades: Trade[] = [];
  let passthrough = 0;
  let inconsistent = 0;
  for (const [tx, t] of byTx) {
    // Decide whether the transaction bought/sold the *asset*, not whether the transaction
    // paid/received a few cents of stablecoin profit while routing through multiple pools.
    // A WETH -> USDT -> WETH round trip is NOT a sale of ETH, even if the route paid a fee.
    const netAsset = t.asset;
    const netStablePaid = t.buyUsd - t.sellUsd;
    if (Math.abs(netAsset) < 1e-12 || Math.abs(netStablePaid) < 1e-9) {
      passthrough++;
      continue;
    }
    // When net asset and quote flow disagree, this may be a complex arbitrage rather than
    // a directional buy/sell. Exclude rather than reporting a confidently wrong direction.
    if ((netAsset > 0) !== (netStablePaid > 0)) {
      inconsistent++;
      continue;
    }
    trades.push({
      tx,
      time: t.time,
      side: netAsset > 0 ? "buy" : "sell",
      usd: Math.abs(netStablePaid),
      asset: netAsset,
    });
  }
  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");
  const buy = buys.reduce((a, t) => a + t.usd, 0);
  const sell = sells.reduce((a, t) => a + t.usd, 0);
  const total = buy + sell;
  const recent = [...trades].sort((a, b) => b.time - a.time || b.usd - a.usd);
  return {
    buy_usd: round2(buy),
    sell_usd: round2(sell),
    net_buy_usd: round2(buy - sell),
    buy_pct: total > 0 ? Math.round((buy / total) * 1000) / 10 : null,
    trade_count: trades.length,
    buy_count: buys.length,
    sell_count: sells.length,
    passthrough_count: passthrough,
    inconsistent_count: inconsistent,
    last_trade_at: recent[0]?.time ?? null,
    // The largest few in the window, newest first among equals: easy to verify on an explorer.
    examples: [...trades].sort((a, b) => b.usd - a.usd || b.time - a.time).slice(0, examples),
  };
}

// ------------------------------------------------------------------ exact integer helpers

/** Two's-complement int256 from a 32-byte hex word. */
export function int256(word: string): bigint {
  if (!/^[0-9a-fA-F]{64}$/.test(word)) throw new Error("bad word");
  const v = BigInt("0x" + word);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

/** Atomic integer amount to a JS number in whole units, exact up to float precision. */
export function units(atomic: bigint, decimals: number): number {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = a % base;
  const n = Number(whole) + Number(frac) / Number(base);
  return neg ? -n : n;
}

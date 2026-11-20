// The DEX research report: exactly four volume metrics plus the evidence needed to verify them.
// It describes executed trades only. It never predicts price direction.
import {
  aggregate,
  TIMEFRAME_LABEL,
  TIMEFRAME_SECONDS,
  type Completeness,
  type SwapLeg,
  type Timeframe,
} from "./volume";

export type PoolRef = { dex: string; pair: string; address: string; url: string };
export type TxRef = { hash: string; side: "buy" | "sell"; usd: number; at: string; url: string };

export type ResearchReport = {
  kind: "dex_volume";
  asset: string;
  /** Plain-language proxy note, e.g. WBTC standing in for BTC. */
  asset_note: string | null;
  chain: string;
  source: string;
  method: string;
  timeframe: Timeframe;
  requested_seconds: number;
  measured_from: string | null;
  measured_to: string | null;
  measured_seconds: number;
  completeness: Completeness;
  buy_usd: number | null;
  sell_usd: number | null;
  net_buy_usd: number | null;
  buy_pct: number | null;
  trade_count: number | null;
  /** Successful pool transactions found in the window (decoded or not), when the source lists them. */
  pool_tx_count: number | null;
  last_trade_at: string | null;
  pools: PoolRef[];
  coverage: string;
  examples: TxRef[];
  calls_used: number;
  headline: string;
  observed_at: string;
  warnings: string[];
  disclaimer: string;
};

export const DISCLAIMER =
  "Executed DEX trades only, stablecoins counted at $1. Buy/sell imbalance is context, not a price forecast or trading advice.";

const iso = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString());
const usd = (n: number) =>
  "$" +
  Math.abs(n).toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2,
    minimumFractionDigits: 0,
  });
export const duration = (secs: number) => {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  return `${Math.max(0, Math.round(secs))} s`;
};

export type ReportInput = {
  asset: string;
  assetNote: string | null;
  chain: string;
  source: string;
  method: string;
  timeframe: Timeframe;
  /** Inclusive measured window in unix seconds; null when nothing could be measured. */
  window: { from: number; to: number } | null;
  complete: boolean;
  legs: SwapLeg[];
  poolTxCount: number | null;
  pools: PoolRef[];
  coverage: string;
  txUrl: (hash: string) => string;
  callsUsed: number;
  warnings: string[];
  observedAt: Date;
};

export function buildReport(i: ReportInput): ResearchReport {
  const requested = TIMEFRAME_SECONDS[i.timeframe];
  const label = TIMEFRAME_LABEL[i.timeframe];
  const base = {
    kind: "dex_volume" as const,
    asset: i.asset,
    asset_note: i.assetNote,
    chain: i.chain,
    source: i.source,
    method: i.method,
    timeframe: i.timeframe,
    requested_seconds: requested,
    pools: i.pools,
    coverage: i.coverage,
    calls_used: i.callsUsed,
    observed_at: i.observedAt.toISOString(),
    warnings: [...i.warnings],
    disclaimer: DISCLAIMER,
    pool_tx_count: i.poolTxCount,
  };
  if (!i.window || i.window.to <= i.window.from) {
    return {
      ...base,
      measured_from: null,
      measured_to: null,
      measured_seconds: 0,
      completeness: "unavailable",
      buy_usd: null,
      sell_usd: null,
      net_buy_usd: null,
      buy_pct: null,
      trade_count: null,
      last_trade_at: null,
      examples: [],
      headline: `${i.asset} DEX buy and sell volume for the last ${label} is unavailable right now. No totals are reported.`,
    };
  }
  const t = aggregate(i.legs, i.window.from, i.window.to);
  const measured = i.window.to - i.window.from;
  // Anything short of the requested span is partial, even if every fetched call succeeded.
  const complete = i.complete && measured >= requested;
  const span = complete
    ? `the last ${label}`
    : `the most recent ${duration(measured)} (partial; ${label} requested)`;
  const where =
    i.pools.length === 1
      ? i.pools[0]!.pair + " on " + i.pools[0]!.dex
      : `${i.pools.length} ${i.pools[0]?.dex ?? "DEX"} pools`;
  const headline =
    t.trade_count === 0
      ? `No executed ${i.asset} swaps in ${span} on ${where}.`
      : `${i.asset} on ${where}, ${span}: ${usd(t.buy_usd)} bought vs ${usd(t.sell_usd)} sold, net ${t.net_buy_usd >= 0 ? "buying" : "selling"} of ${usd(t.net_buy_usd)}; buys were ${t.buy_pct}% of volume across ${t.trade_count} trade${t.trade_count === 1 ? "" : "s"}.`;
  if (t.inconsistent_count)
    base.warnings.push(
      `${t.inconsistent_count} complex routed transaction(s) had contradictory net asset and stablecoin flows and were excluded from directional volume.`,
    );
  const thin = t.trade_count > 0 && t.buy_usd + t.sell_usd < 10_000;
  if (thin)
    base.warnings.push(
      `The monitored pools contain only ${usd(t.buy_usd + t.sell_usd)} in the measured window. This is a thin sample, not a market-wide signal.`,
    );
  if (t.passthrough_count)
    base.warnings.push(
      `${t.passthrough_count} transactions only routed through the asset and were netted to zero.`,
    );
  return {
    ...base,
    measured_from: iso(i.window.from),
    measured_to: iso(i.window.to),
    measured_seconds: measured,
    completeness: complete ? "complete" : "partial",
    buy_usd: t.buy_usd,
    sell_usd: t.sell_usd,
    net_buy_usd: t.net_buy_usd,
    buy_pct: t.buy_pct,
    trade_count: t.trade_count,
    last_trade_at: iso(t.last_trade_at),
    examples: t.examples.map((x) => ({
      hash: x.tx,
      side: x.side,
      usd: Math.round(x.usd * 100) / 100,
      at: new Date(x.time * 1000).toISOString(),
      url: i.txUrl(x.tx),
    })),
    headline:
      headline +
      (thin ? " The observed dollar volume is small and not representative of broad market pressure." : "") +
      (i.assetNote ? ` ${i.assetNote}` : ""),
  };
}

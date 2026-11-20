// Free, verified market context for the selected contract: Gemini's own contract terms and prices,
// plus the event's settlement index (the price series the contract actually resolves against) from
// Gemini's public klines. No payment, no third-party price feed, no invented spot values.
import type { AssetIdentity, MarketSelection } from "./asset";

export type Kline = [number, number, number, number, number, ...unknown[]];
/** Returns 1-minute klines for an index, or null when unavailable. */
export type KlineSource = (
  agency: string,
  index: string,
  from: number,
  to: number,
) => Promise<unknown>;

export type SpotContext = {
  source: string;
  last: number;
  as_of: string;
  change_60m_pct: number | null;
  realized_vol_60m_pct: number | null;
  high_60m: number;
  low_60m: number;
  minutes: number;
  distance_to_strike_pct: number | null;
};

export type MarketContext = {
  asset: AssetIdentity;
  market: MarketSelection;
  implied_yes_pct: number | null;
  spread: number | null;
  spot: SpotContext | null;
  limitations: string[];
};

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const SAFE = /^[A-Za-z0-9_-]{1,40}$/;

export function spotFromKlines(
  rows: unknown,
  strike: string | null,
  source: string,
): SpotContext | null {
  if (!Array.isArray(rows)) return null;
  const bars = rows
    .filter(
      (r): r is Kline =>
        Array.isArray(r) &&
        typeof r[0] === "number" &&
        [1, 2, 3, 4].every(
          (i) => typeof r[i] === "number" && Number.isFinite(r[i]) && (r[i] as number) > 0,
        ),
    )
    .sort((a, b) => a[0] - b[0]);
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b[4]);
  const last = closes.at(-1)!;
  const first = closes[0]!;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const variance =
    rets.length > 1 ? rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1) : null;
  const k = Number(strike);
  return {
    source,
    last: round(last, 6),
    as_of: new Date(bars.at(-1)![0] + 60_000).toISOString(),
    change_60m_pct: round(((last - first) / first) * 100),
    // Realized volatility of 1-minute log returns, scaled to the observed window (not annualized).
    realized_vol_60m_pct:
      variance === null ? null : round(Math.sqrt(variance * rets.length) * 100, 3),
    high_60m: round(Math.max(...bars.map((b) => b[2])), 6),
    low_60m: round(Math.min(...bars.map((b) => b[3])), 6),
    minutes: bars.length,
    distance_to_strike_pct:
      strike !== null && Number.isFinite(k) && k > 0 ? round(((k - last) / last) * 100) : null,
  };
}

export async function buildContext(
  asset: AssetIdentity,
  market: MarketSelection,
  klines: KlineSource,
  now = Date.now(),
): Promise<MarketContext> {
  const limitations: string[] = [];
  let spot: SpotContext | null = null;
  const { settlement_agency: agency, settlement_index: index } = market;
  if (agency && index && SAFE.test(agency) && SAFE.test(index)) {
    const rows = await klines(agency, index, now - 61 * 60_000, now).catch(() => null);
    spot = spotFromKlines(
      rows,
      market.strike,
      `Gemini Sandbox settlement index ${agency} ${index}`,
    );
    if (!spot)
      limitations.push(
        `Settlement index ${index} history is unavailable, so no spot or volatility context is shown.`,
      );
  } else
    limitations.push(
      "The market does not name a settlement index, so no spot or volatility context is shown.",
    );
  const { yes_buy, yes_sell } = market.prices;
  return {
    asset,
    market,
    implied_yes_pct: yes_buy === null ? null : round(yes_buy * 100, 1),
    spread: yes_buy !== null && yes_sell !== null ? round(yes_buy - yes_sell, 4) : null,
    spot,
    limitations,
  };
}

// Cross-venue comparison. Pure functions.
// Rule: different venues' contracts are never called identical. Every match carries labelled
// differences (strike, expiry, settlement index, structure, fees). Other venues' prices are
// "what other traders pay", never Gemini's fair value and never a forecast.

export type GeminiSide = {
  eventTicker: string;
  title: string;
  asset: string | null; // BTC, ETH, SOL, XRP...
  contractLabel: string;
  strike: number | null;
  structure: Structure;
  expiry: string | null; // ISO
  settlement: string | null; // e.g. "lukka LS-LRRR-XBTUSD"
  yesAsk: number | null;
  yesBid: number | null;
  feePerContractEst: number | null;
};

export type Structure = "above" | "below" | "up_down" | "range" | "unknown";

export type ExternalMarket = {
  venue: string;
  id: string;
  title: string;
  asset: string | null;
  strike: number | null;
  structure: Structure;
  expiry: string | null;
  settlement: string | null;
  yesAsk: number | null;
  yesBid: number | null;
  volume: number | null;
  url: string | null;
};

export type MatchType =
  "same_strike_same_expiry" | "nearby_strike" | "different_structure" | "different_expiry";

export type Comparison = {
  market: ExternalMarket;
  match: MatchType;
  differences: string[];
  strikeDiff: number | null;
  expiryDiffMinutes: number | null;
  priceGapCents: number | null; // Gemini ask minus external ask, YES side
};

const ASSETS: [string, RegExp][] = [
  ["BTC", /\b(btc|xbt|bitcoin)\b/i],
  ["ETH", /\b(eth|ether|ethereum)\b/i],
  ["SOL", /\b(sol|solana)\b/i],
  ["XRP", /\b(xrp|ripple)\b/i],
  ["DOGE", /\b(doge|dogecoin)\b/i],
];
export const ASSET_QUERY: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "xrp",
  DOGE: "dogecoin",
};

export function detectAsset(text: string): string | null {
  for (const [sym, re] of ASSETS) if (re.test(text)) return sym;
  return null;
}

export function detectStructure(text: string): Structure {
  if (/\bup\b.*\bdown\b|up or down|\bup\/down\b/i.test(text)) return "up_down";
  if (/\bbetween\b|\brange\b|\bto\s+\$?[\d,]+/i.test(text)) return "range";
  if (/\b(or above|above|over|at least|greater|higher than|≥|>)\b/i.test(text)) return "above";
  if (/\b(or below|below|under|less than|lower than)\b/i.test(text)) return "below";
  return "unknown";
}

export function parseStrike(text: string): number | null {
  const m =
    /\$\s?([\d,]+(?:\.\d+)?)\s*(k)?/i.exec(text) ?? /\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\b/.exec(text);
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

// ---------- normalizing the provider response ----------

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
/** Prices may be dollars (0.36), cents (36) or percent strings. Return a 0..1 probability price. */
const price = (v: unknown): number | null => {
  const n = num(typeof v === "string" ? v.replace(/[¢%]/g, "") : v);
  if (n === null) return null;
  if (n > 0 && n < 1) return n;
  if (n >= 1 && n < 100) return n / 100;
  return null;
};
const iso = (v: unknown): string | null => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Finds market-like objects anywhere in the provider payload (schema is not published). */
export function extractMarkets(payload: unknown): ExternalMarket[] {
  const out: ExternalMarket[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, venueHint: string | null, depth: number) => {
    if (depth > 6 || v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x, venueHint, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const title = str(
      pick(o, [
        "title",
        "question",
        "name",
        "market_title",
        "yes_sub_title",
        "subtitle",
        "description",
      ]),
    );
    const yes = pick(o, [
      "yes_ask",
      "yesAsk",
      "yes_ask_dollars",
      "yes_price",
      "yesPrice",
      "best_ask",
      "bestAsk",
      "ask",
      "price",
      "last_price",
      "lastPrice",
      "probability",
    ]);
    const looksLikeMarket =
      title &&
      (yes !== undefined ||
        pick(o, ["ticker", "market_id", "condition_id", "slug", "id"]) !== undefined);
    if (looksLikeMarket && title) {
      const venue =
        str(pick(o, ["venue", "source", "platform", "exchange", "provider"])) ??
        venueHint ??
        "unknown";
      const fullText = [title, str(o["subtitle"]), str(o["yes_sub_title"]), str(o["ticker"])]
        .filter(Boolean)
        .join(" ");
      const strike =
        num(pick(o, ["strike", "floor_strike", "strike_price", "threshold"])) ??
        parseStrike(fullText);
      const vol = num(
        pick(o, [
          "volume_24h",
          "volume24h",
          "volume_24h_fp",
          "volume",
          "volume_usd",
          "volumeUsd",
          "liquidity",
        ]),
      );
      out.push({
        venue: venue.toLowerCase(),
        id: String(pick(o, ["ticker", "market_id", "condition_id", "slug", "id"]) ?? title),
        title,
        asset: detectAsset(fullText),
        strike,
        structure: detectStructure(fullText),
        expiry: iso(
          pick(o, [
            "close_time",
            "closeTime",
            "end_date",
            "endDate",
            "expiration_time",
            "expiry",
            "expiryDate",
            "resolution_time",
          ]),
        ),
        settlement:
          str(
            pick(o, [
              "settlement_source",
              "resolution_source",
              "resolutionSource",
              "rules_primary",
              "rules",
            ]),
          )?.slice(0, 240) ?? null,
        yesAsk: price(yes),
        yesBid: price(
          pick(o, ["yes_bid", "yesBid", "yes_bid_dollars", "best_bid", "bestBid", "bid"]),
        ),
        volume: vol,
        url: str(pick(o, ["url", "link", "market_url"])),
      });
      return;
    }
    for (const [k, child] of Object.entries(o)) {
      const hint = /polymarket|kalshi|limitless|opinion|predict/i.test(k)
        ? k.toLowerCase()
        : venueHint;
      visit(child, hint, depth + 1);
    }
  };
  visit(payload, null, 0);
  return out;
}

// ---------- matching ----------

export function settlementLabel(text: string | null): string | null {
  if (!text) return null;
  if (/cf benchmarks|brti|cfb/i.test(text)) return "CF Benchmarks index";
  if (/chainlink/i.test(text)) return "Chainlink feed";
  if (/lukka/i.test(text)) return "Lukka index";
  if (/binance/i.test(text)) return "Binance price";
  if (/coinbase/i.test(text)) return "Coinbase price";
  return null;
}

export function compare(g: GeminiSide, markets: ExternalMarket[], max = 6, now = Date.now()): Comparison[] {
  const gExp = g.expiry ? Date.parse(g.expiry) : NaN;
  const rows: Comparison[] = [];
  for (const m of markets) {
    if (!g.asset || m.asset !== g.asset) continue;
    if (m.venue.includes("gemini")) continue;
    const differences: string[] = [];
    const mExp = m.expiry ? Date.parse(m.expiry) : NaN;
    const expiryDiffMinutes =
      Number.isFinite(gExp) && Number.isFinite(mExp) ? Math.round((mExp - gExp) / 60000) : null;
    if (expiryDiffMinutes !== null && Math.abs(expiryDiffMinutes) > 24 * 60) continue; // too far apart to be useful
    if (Number.isFinite(mExp) && mExp <= now) continue; // already closed: its last price is stale
    const strikeDiff = g.strike !== null && m.strike !== null ? round2(m.strike - g.strike) : null;

    let match: MatchType;
    if (m.structure !== g.structure || g.structure === "unknown") {
      match = "different_structure";
      differences.push(
        `Different contract type (${pretty(m.structure)} vs Gemini ${pretty(g.structure)}).`,
      );
    } else if (expiryDiffMinutes === null || Math.abs(expiryDiffMinutes) > 5) {
      match = "different_expiry";
    } else if (
      strikeDiff !== null &&
      g.strike !== null &&
      Math.abs(strikeDiff) <= Math.max(0.011, g.strike * 0.0001)
    ) {
      match = "same_strike_same_expiry";
    } else {
      match = "nearby_strike";
    }

    if (expiryDiffMinutes === null) differences.push("Expiry time not reported.");
    else if (expiryDiffMinutes !== 0)
      differences.push(
        `Expires ${fmtMinutes(expiryDiffMinutes)} ${expiryDiffMinutes > 0 ? "after" : "before"} Gemini.`,
      );
    if (strikeDiff === null) differences.push("Strike not reported.");
    else if (strikeDiff !== 0)
      differences.push(
        `Strike ${strikeDiff > 0 ? "+" : ""}${strikeDiff.toLocaleString("en-US")} vs Gemini.`,
      );
    const ms = settlementLabel(m.settlement);
    const gs = settlementLabel(g.settlement);
    if (!ms) differences.push("Settlement source not reported.");
    else if (ms !== gs)
      differences.push(
        `Settles to ${ms}; Gemini settles to ${gs ?? g.settlement ?? "its own index"}.`,
      );
    differences.push("Fees and rules differ by venue; external fees not included.");

    rows.push({
      market: m,
      match,
      differences,
      strikeDiff,
      expiryDiffMinutes,
      priceGapCents:
        g.yesAsk !== null && m.yesAsk !== null ? Math.round((g.yesAsk - m.yesAsk) * 100) : null,
    });
  }
  const rank: Record<MatchType, number> = {
    same_strike_same_expiry: 0,
    nearby_strike: 1,
    different_expiry: 2,
    different_structure: 3,
  };
  rows.sort(
    (a, b) =>
      rank[a.match] - rank[b.match] ||
      Math.abs(a.strikeDiff ?? 1e12) - Math.abs(b.strikeDiff ?? 1e12) ||
      (b.market.volume ?? 0) - (a.market.volume ?? 0),
  );
  return rows.slice(0, max);
}

/** Short, honest spoken summary. Never a forecast, never "identical", never an instruction to trade. */
export function spokenSummary(g: GeminiSide, rows: Comparison[]): string {
  const best =
    rows.find((r) => r.match === "same_strike_same_expiry") ??
    rows.find((r) => r.match === "nearby_strike");
  if (!best)
    return rows.length
      ? "Other venues only list different kinds of contracts on this, so I can't line the prices up fairly."
      : "No comparable markets found on other venues.";
  const m = best.market;
  const venue = m.venue.charAt(0).toUpperCase() + m.venue.slice(1);
  const parts = [
    `${venue} has ${best.match === "same_strike_same_expiry" ? "the same strike and expiry" : "a nearby strike"}: ${m.title}` +
      (m.yesAsk !== null ? `, YES at ${Math.round(m.yesAsk * 100)} cents` : "") +
      (m.volume !== null ? `, about ${compact(m.volume)} traded` : "") +
      ".",
  ];
  if (g.yesAsk !== null && m.yesAsk !== null)
    parts.push(`Gemini's ask is ${Math.round(g.yesAsk * 100)} cents.`);
  const settle = best.differences.find((d) => d.startsWith("Settles to"));
  if (settle) parts.push(`Not the same bet: ${settle.replace(/\.$/, "")}.`);
  if (best.priceGapCents !== null && Math.abs(best.priceGapCents) >= 20)
    parts.push("A gap that large usually reflects different rules, thin liquidity or Gemini's test market, not a sure profit.");
  parts.push("That's what other traders pay, not a forecast or Gemini's fair price.");
  return parts.join(" ");
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pretty = (s: Structure) =>
  ({
    above: "above-strike",
    below: "below-strike",
    up_down: "up-or-down",
    range: "price range",
    unknown: "unknown",
  })[s];
const fmtMinutes = (m: number) => {
  const a = Math.abs(m);
  return a < 60 ? `${a} min` : `${Math.round(a / 6) / 10} h`;
};
const compact = (n: number) =>
  n >= 1e6
    ? `$${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `$${Math.round(n / 1e3)}k`
      : `$${Math.round(n)}`;

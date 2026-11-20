import { marketTitle } from "../market-title";
// Identify the exact Gemini Sandbox market and its underlying cryptocurrency from Gemini's own
// event and contract metadata. No coin list is consulted here: the symbol and name come from the
// contract rules text, title, event ticker and series, and independent fields must agree.
import type { Contract, GEvent } from "../gemini";

export type AssetIdentity = {
  symbol: string;
  name: string | null;
  /** Which metadata fields named the symbol (at least two, all in agreement). */
  identified_from: string[];
};

export type MarketSelection = {
  event_ticker: string;
  /** Gemini series (e.g. BTC05M, ETH15M, SOL1H); sets the default research timeframe. */
  series: string | null;
  contract_symbol: string;
  title: string | null;
  contract_label: string | null;
  strike_type: string | null;
  strike: string | null;
  expiry: string | null;
  settlement_agency: string | null;
  settlement_index: string | null;
  prices: {
    yes_buy: number | null;
    no_buy: number | null;
    yes_sell: number | null;
    no_sell: number | null;
  };
};

export class AssetError extends Error {
  constructor(
    public code: "NOT_CRYPTO" | "CONTRACT_MISMATCH" | "ASSET_UNRESOLVED" | "ASSET_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

type Loose = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const SYMBOL = /^[A-Z0-9]{2,12}$/;

/** Flatten Gemini's rich-text contract description into plain text. */
export function descriptionText(d: unknown): string {
  if (typeof d === "string") return d;
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as Loose;
    if (typeof o["value"] === "string") out.push(o["value"]);
    if (Array.isArray(o["content"])) o["content"].forEach(walk);
  };
  walk(d);
  return out.join(" ");
}

const price = (v: unknown) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n > 0 && n < 1
    ? n
    : null;
};

/** Throws AssetError unless the contract belongs to the event and the asset is unambiguous. */
export function identifyMarket(
  event: GEvent | null,
  contract: Contract | null,
  eventTicker: string,
  contractSymbol: string,
) {
  const ev = (event ?? {}) as Loose;
  const c = (contract ?? {}) as Loose;
  if (!event || !contract)
    throw new AssetError("CONTRACT_MISMATCH", "The selected contract was not found in that event.");
  if (str(ev["ticker"]) !== eventTicker || str(c["instrumentSymbol"]) !== contractSymbol)
    throw new AssetError("CONTRACT_MISMATCH", "The selected contract does not match the event.");
  const contracts = Array.isArray(ev["contracts"]) ? (ev["contracts"] as Loose[]) : [];
  if (!contracts.some((x) => x?.["instrumentSymbol"] === contractSymbol))
    throw new AssetError("CONTRACT_MISMATCH", "The selected contract is not listed in that event.");
  if (contractSymbol.startsWith("GEMI-") && !contractSymbol.startsWith(`GEMI-${eventTicker}-`))
    throw new AssetError("CONTRACT_MISMATCH", "The contract symbol belongs to a different event.");
  const evSource = str(ev["source"]) ?? str((ev["sourceDetails"] as Loose | undefined)?.["index"]);
  const cSource = str(c["source"]);
  if (evSource && cSource && evSource !== cSource)
    throw new AssetError(
      "CONTRACT_MISMATCH",
      "The contract settles on a different index than its event.",
    );

  const sub = (ev["subcategory"] ?? {}) as Loose;
  const path = Array.isArray(sub["path"]) ? (sub["path"] as unknown[]).map(String) : [];
  const category = str(ev["category"]) ?? path[0] ?? null;
  if (!category || category.toLowerCase() !== "crypto")
    throw new AssetError(
      "NOT_CRYPTO",
      "Research is available for cryptocurrency predictions only.",
    );

  // Independent symbol votes.
  const votes: Array<[string, string]> = [];
  const desc = descriptionText(c["description"]);
  const m = /price of ([^()]{1,60}?)\s*\(([A-Za-z0-9]{2,12})\)/i.exec(desc);
  if (m) votes.push(["contract_rules", m[2]!.toUpperCase()]);
  const t = /^([A-Za-z0-9]{2,12}) price\b/i.exec(str(ev["title"]) ?? "");
  if (t) votes.push(["title", t[1]!.toUpperCase()]);
  const k = /^([A-Z]{2,12}?)(?:\d{2}M)?\d{10}$/.exec(eventTicker);
  if (k) votes.push(["event_ticker", k[1]!]);
  const s = /^([A-Z]{2,12}?)\d+[A-Z]$/.exec(str(ev["series"]) ?? "");
  if (s) votes.push(["series", s[1]!]);
  const symbols = new Set(votes.map(([, v]) => v).filter((v) => SYMBOL.test(v)));
  if (symbols.size > 1)
    throw new AssetError("ASSET_CONFLICT", "The market's metadata names more than one asset.");
  const symbol = [...symbols][0];
  if (!symbol || votes.length < 2)
    throw new AssetError(
      "ASSET_UNRESOLVED",
      "The market's underlying asset could not be confirmed from Gemini metadata.",
    );
  const name = (m?.[1]?.trim() || str(sub["name"]) || null)?.slice(0, 60) ?? null;

  const strike = (c["strike"] ?? {}) as Loose;
  const sd = (ev["sourceDetails"] ?? {}) as Loose;
  const p = (c["prices"] ?? {}) as Loose;
  const buy = (p["buy"] ?? {}) as Loose;
  const sell = (p["sell"] ?? {}) as Loose;
  const asset: AssetIdentity = { symbol, name, identified_from: votes.map(([f]) => f) };
  const expiry = str(c["expiryDate"]) ?? str(ev["expiryDate"]);
  const title = str(ev["title"]);
  const label = str(c["label"]);
  const market: MarketSelection = {
    event_ticker: eventTicker,
    series: str(ev["series"])?.slice(0, 40) ?? null,
    contract_symbol: contractSymbol,
    title: title ? marketTitle(title, expiry).slice(0, 200) : null,
    contract_label: label ? marketTitle(label, expiry).slice(0, 200) : null,
    strike_type: str(strike["type"]),
    strike: strike["value"] != null ? String(strike["value"]).slice(0, 40) : null,
    expiry,
    settlement_agency: str(sd["agency"]),
    settlement_index: str(sd["index"]) ?? evSource,
    prices: {
      yes_buy: price(buy["yes"]),
      no_buy: price(buy["no"]),
      yes_sell: price(sell["yes"]),
      no_sell: price(sell["no"]),
    },
  };
  return { asset, market };
}

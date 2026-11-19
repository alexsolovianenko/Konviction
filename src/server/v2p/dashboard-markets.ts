import type { MarketContract, MarketEvent, MarketsSnapshot } from "../../components/console/types";
import { featuredListingPage, geminiReadError, gPublic } from "./gemini";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const nonnegative = (value: unknown) => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const price = (value: unknown) => {
  const n = nonnegative(value);
  return n !== null && n <= 1 ? n : null;
};
const quote = (value: unknown) => {
  const q = record(value);
  return { yes: price(q?.['yes']), no: price(q?.['no']) };
};

export function dashboardMarketsFrom(data: unknown): MarketEvent[] | null {
  const rows = record(data)?.['data'];
  if (!Array.isArray(rows)) return null;
  const events: MarketEvent[] = [];
  for (const row of rows) {
    const e = record(row);
    const ticker = text(e?.['ticker']);
    const title = text(e?.['title']);
    if (e && ticker && title) {
      const contracts: MarketContract[] = [];
      const listed = e['contracts'];
      for (const item of Array.isArray(listed) ? listed : []) {
        const c = record(item);
        const symbol = text(c?.['instrumentSymbol']);
        if (!c || !symbol) continue;
        const prices = record(c['prices']);
        const strike = record(c["strike"]);
        const strikeValue = nonnegative(strike?.["value"]);
        contracts.push({
          ...(typeof strike?.["type"] === "string" && strikeValue !== null && {strike:{type:strike["type"],value:strikeValue}}),
          symbol, label: text(c['label']), status: text(c['status']), market_state: text(c['marketState']),
          expiry: text(c['expiryDate']), buy: quote(prices?.['buy']), sell: quote(prices?.['sell']),
        });
      }
      const tags = [...(Array.isArray(e["tags"]) ? e["tags"] : []), ...(Array.isArray(e["eventTags"]) ? e["eventTags"].map(t => record(t)?.["name"]) : [])].filter((t): t is string => typeof t === "string");
      events.push({ tags, series:text(e["series"]), start_time:text(e["startTime"]), ticker, title, category: text(e['category']), status: text(e['status']), volume_usd: nonnegative(e['volume']),
        volume_24h_usd: nonnegative(e['volume24h']), created_at: text(e['createdAt']), contracts });
    }
    const children = e?.['events'];
    if (Array.isArray(children)) events.push(...(dashboardMarketsFrom({ data: children }) ?? []));
  }
  return events.length || rows.length === 0 ? events : null;
}

let cache: { at: number; value: MarketsSnapshot } | undefined;

async function loadEvents(): Promise<MarketsSnapshot> {
  const as_of = new Date().toISOString();
  const events = new Map<string, MarketEvent>();
  let offset = 0;
  for (;;) {
    const result = await gPublic("/v1/prediction-markets/events", { status: "active", limit: 100, offset });
    if (!result.ok) return { events: [], error: geminiReadError(result) };
    const page = dashboardMarketsFrom(result.data);
    if (!page) return { events: [], error: "Gemini returned an unexpected events response." };
    for (const event of page) events.set(event.ticker, event);
    const count = result.data.data.length;
    offset += count;
    if (!count || !Number.isSafeInteger(result.data.pagination?.total) || offset >= result.data.pagination.total) break;
  }
  return { events: [...events.values()], as_of, error: null };
}

async function loadFeaturedRanks() {
  const ranks = new Map<string, number>();
  let offset = 0;
  for (;;) {
    const response = await featuredListingPage(offset);
    if (!response.ok) return null;
    const rows = dashboardMarketsFrom(response.data);
    if (!rows) return null;
    for (const row of rows) if (!ranks.has(row.ticker)) ranks.set(row.ticker, ranks.size);
    const count = response.data.data.length;
    offset += count;
    if (!count || !Number.isSafeInteger(response.data.pagination?.total) || offset >= response.data.pagination.total) return ranks;
  }
}

let pendingBrowse: Promise<{ value: MarketsSnapshot; ranked: boolean }> | undefined;

async function loadBrowseSnapshot() {
  const [value, ranks] = await Promise.all([loadEvents(), loadFeaturedRanks()]);
  if (!value.error && ranks) {
    for (const event of value.events) event.featured_rank = ranks.get(event.ticker) ?? null;
    cache = { at: Date.parse(value.as_of!), value };
  }
  return { value, ranked: ranks !== null };
}

export async function dashboardMarkets({ fresh = false, requireFeatured = false } = {}): Promise<MarketsSnapshot> {
  if (fresh) return loadEvents();
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  pendingBrowse ??= loadBrowseSnapshot().finally(() => { pendingBrowse = undefined; });
  const { value, ranked } = await pendingBrowse;
  if (requireFeatured && !ranked && !value.error) return { events: [], error: "Gemini Sandbox featured ranking unavailable." };
  return value;
}

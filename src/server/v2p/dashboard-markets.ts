import type { MarketContract, MarketEvent, MarketsSnapshot } from "../../components/console/types";
import { geminiReadError, gPublic } from "./gemini";

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
        contracts.push({
          symbol, label: text(c['label']), status: text(c['status']), market_state: text(c['marketState']),
          expiry: text(c['expiryDate']), buy: quote(prices?.['buy']), sell: quote(prices?.['sell']),
        });
      }
      events.push({ ticker, title, category: text(e['category']), status: text(e['status']), volume_usd: nonnegative(e['volume']), contracts });
    }
    const children = e?.['events'];
    if (Array.isArray(children)) events.push(...(dashboardMarketsFrom({ data: children }) ?? []));
  }
  return events.length || rows.length === 0 ? events : null;
}

let cache: { at: number; value: MarketsSnapshot } | undefined;

export async function dashboardMarkets(fresh = false): Promise<MarketsSnapshot> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.value;
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
  const value: MarketsSnapshot = { events: [...events.values()], error: null };
  cache = { at: Date.now(), value };
  return value;
}
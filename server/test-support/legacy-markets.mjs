// Historical v2 API fixtures, used only by frozen contract regression tests.
import { api } from '../contracts.mjs';
const catalog = api['x-simulated-catalog'];
const stopWords = new Set([
  'market',
  'markets',
  'contract',
  'contracts',
  'price',
  'prices',
  'spot',
  'prediction',
  'predictions',
  'gemini',
  'the',
  'and',
  'for',
]);
const bounded = (text, max) => Array.from(text).slice(0, max).join('');
const fold = s => s.normalize('NFKC').toLowerCase();
export function legacyMarket(name, p, intent, result) {
  const market = catalog[p.venue].find(item => item.instrument === p.instrument);
  if (name === 'search_markets') {
    intent.instrument = bounded(p.query.trim(), 64);
    const words = fold(p.query).match(/[\p{L}\p{Nd}]+/gu) ?? [];
    const terms = words.filter((word) => Array.from(word).length >= 3 && !stopWords.has(word));
    const results = catalog[p.venue]
      .filter(
        (item) =>
          terms.length > 0 &&
          terms.every((term) =>
            [item.title, item.instrument, ...item.aliases].some((s) => fold(s).includes(term)),
          ),
      )
      .slice(0, p.limit ?? 3)
      .map(({ aliases, yes_book, bids, asks, ...item }) =>
        bids
          ? { ...item, venue: p.venue, best_bid: bids[0].price, best_ask: asks[0].price }
          : { ...item, venue: p.venue },
      );
    Object.assign(result, {
      venue: p.venue,
      as_of: intent.created_at,
      count: results.length,
      results,
    });
  } else {
    const book = market.yes_book ?? market;
    const bids = book.bids.slice(0, p.depth ?? 3),
      asks = book.asks.slice(0, p.depth ?? 3);
    const best_bid = bids[0]?.price ?? null,
      best_ask = asks[0]?.price ?? null;
    Object.assign(result, {
      venue: p.venue,
      instrument: market.instrument,
      as_of: intent.created_at,
      bids,
      asks,
      best_bid,
      best_ask,
      spread:
        best_ask == null || best_bid == null ? null : Number((best_ask - best_bid).toFixed(2)),
    });
  }
}

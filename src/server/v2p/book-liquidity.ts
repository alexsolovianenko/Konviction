// Gemini publishes a single YES book. A NO buy consumes YES bids at 1 - bid.
type Level = { price: number; amount: number };
export type LiquidityQuery = {
  outcome: 'yes' | 'no'; side: 'buy' | 'sell'; quantity: number | null; limit_price: number | null;
};

function decimal(value: unknown) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d*\.?\d+$/.test(value))) return NaN;
  return Number(value);
}

function levels(raw: unknown, complement: boolean): Level[] | null {
  if (!Array.isArray(raw)) return null;
  const result: Level[] = [];
  for (const row of raw) {
    const price = decimal(row?.price);
    const amount = decimal(row?.amount);
    if (!(price > 0 && price < 1 && Number.isFinite(amount) && amount > 0)) return null;
    result.push({ price: complement ? Number((1 - price).toFixed(12)) : price, amount });
  }
  return result;
}

export function topBookPrice(book: { bids?: unknown; asks?: unknown }, outcome: string, side: string) {
  const no = outcome === "no";
  const rows = levels((side === "buy") !== no ? book.asks : book.bids, no);
  if (!rows) return undefined;
  if (!rows.length) return null;
  return rows.reduce((best, row) => side === "buy" ? Math.min(best, row.price) : Math.max(best, row.price), rows[0]!.price);
}

export function liquiditySnapshot(book: { bids?: unknown; asks?: unknown } | null, query: LiquidityQuery) {
  const no = query.outcome === 'no';
  const asks = levels(no ? book?.bids : book?.asks, no)?.sort((a,b) => a.price - b.price);
  const bids = levels(no ? book?.asks : book?.bids, no)?.sort((a,b) => b.price - a.price);
  const buying = query.side === 'buy';
  const rawSpread = asks?.length && bids?.length ? asks[0]!.price - bids[0]!.price : null;
  const crossed = rawSpread !== null && rawSpread < 0;
  const eligible = crossed ? undefined : (buying ? asks : bids)?.filter(({price}) =>
    query.limit_price === null || (buying ? price <= query.limit_price : price >= query.limit_price));
  let depth = 0, filled = 0, cost = 0;
  for (const {price, amount} of eligible ?? []) {
    depth += amount;
    if (query.quantity !== null && filled < query.quantity) {
      const take = Math.min(amount, query.quantity - filled);
      filled += take;
      cost += take * price;
    }
  }
  const known = eligible !== undefined && Number.isFinite(depth);
  return {
    ...query, snapshot_only: true, depth_unknown: !known,
    spread: rawSpread === null || crossed ? null : Number(rawSpread.toFixed(12)),
    displayed_quantity: known ? Number(depth.toFixed(12)) : null,
    estimated_executable_quantity: known && query.quantity !== null ? Number(filled.toFixed(12)) : null,
    estimated_average_price: known && filled > 0 ? Number((cost / filled).toFixed(12)) : null,
  };
}

export type ChartAction = 'explore' | 'yes' | 'no';
export const isChartAction = (value: unknown): value is ChartAction =>
  value === 'explore' || value === 'yes' || value === 'no';

// Six fabricated minute marks span exactly five minutes.
const prices = [97320, 97382, 97356, 97424, 97402, 97455];
const points = prices.map((price_usd, minute) => ({ time_utc: '14:0' + minute, price_usd }));
const open = prices[0],
  last = prices[prices.length - 1];
const contract = {
  venue: 'gemini_prediction',
  instrument: 'BTC-150K-2026',
  title: 'Will Bitcoin trade above 150,000 dollars before January 1, 2027?',
  closes_at: '2026-12-31T23:59:00Z',
  yes_bid: 0.17, yes_ask: 0.18, no_bid: 0.82, no_ask: 0.83,
  price_unit: 'USD per contract',
} as const;
type ContractPreview = {
  venue: typeof contract.venue;
  instrument: typeof contract.instrument;
  side: 'yes' | 'no';
  contract_price: number;
  contract_price_cents: number;
  execution: 'none';
};
const market = {
  underlying_unit: 'USD per bitcoin' as const,
  contract,
  simulated: true as const,
  symbol: 'BTC/USD',
  window_minutes: 5,
  points,
  open_usd: open,
  last_usd: last,
  high_usd: Math.max(...prices),
  low_usd: Math.min(...prices),
  change_usd: last - open,
  change_percent: Number((((last - open) / open) * 100).toFixed(2)),
  trend: 'up' as const,
};
export const initialChart = {
  ...market,
  update: 0,
  action: null as ChartAction | 'cancel' | null,
  selected: points[points.length - 1],
  preview: null as ContractPreview | null,
};
export type DemoChart = typeof initialChart;

export function applyChartAction(chart: DemoChart, action: ChartAction | 'cancel'): DemoChart {
  const selected =
    action === 'explore'
      ? points[(points.indexOf(chart.selected) + 1) % points.length]
      : points[points.length - 1];
  let preview = chart.preview;
  if (action === 'cancel') preview = null;
  if (action === 'yes' || action === 'no') {
    const price = action === 'yes' ? contract.yes_ask : contract.no_ask;
    preview = { venue: contract.venue, instrument: contract.instrument, side: action,
      contract_price: price, contract_price_cents: Math.round(price * 100), execution: 'none' };
  }
  return { ...market, update: chart.update + 1, action, selected, preview };
}

export type ChartAction = 'explore' | 'buy' | 'sell';
export const isChartAction = (value: unknown): value is ChartAction =>
  value === 'explore' || value === 'buy' || value === 'sell';

// Six fabricated minute marks span exactly five minutes.
const prices = [97320, 97382, 97356, 97424, 97402, 97455];
const points = prices.map((price_usd, minute) => ({ time_utc: '14:0' + minute, price_usd }));
const open = prices[0],
  last = prices[prices.length - 1];
const market = {
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
  preview: null as { side: 'buy' | 'sell'; price_usd: number; execution: 'none' } | null,
};
export type DemoChart = typeof initialChart;

export function applyChartAction(chart: DemoChart, action: ChartAction | 'cancel'): DemoChart {
  const selected =
    action === 'explore'
      ? points[(points.indexOf(chart.selected) + 1) % points.length]
      : points[points.length - 1];
  const preview =
    action === 'buy' || action === 'sell'
      ? { side: action, price_usd: last, execution: 'none' as const }
      : action === 'cancel'
        ? null
        : chart.preview;
  return { ...market, update: chart.update + 1, action, selected, preview };
}

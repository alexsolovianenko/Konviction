import type { ChartAction, DemoChart } from '../demoChart';

const dollars = (value: number) => '$' + value.toLocaleString('en-US');

export function DemoChartPanel({
  chart,
  act,
}: {
  chart: DemoChart;
  act: (action: ChartAction | 'cancel') => void;
}) {
  const x = (i: number) => 48 + i * 82;
  const y = (price: number) =>
    132 - (84 * (price - chart.low_usd)) / (chart.high_usd - chart.low_usd);
  const path = chart.points.map((p, i) => x(i) + ',' + y(p.price_usd)).join(' ');
  const message =
    chart.action === 'cancel'
      ? 'Preview cancelled'
      : chart.action === 'explore'
        ? 'Exploring ' + chart.selected.time_utc + ' UTC'
        : chart.preview
          ? (chart.preview.side === 'buy' ? 'Buy' : 'Sell') + ' preview'
          : '';
  return (
    <section className="chart-panel" aria-labelledby="chart-title">
      <div className="chart-heading">
        <h2 id="chart-title">BTC/USD</h2>
        <span>Simulated · 5 min</span>
      </div>
      <div className="chart-price">
        {dollars(chart.last_usd)} <span>USD</span>
      </div>
      <p className="chart-trend">
        ↗ Up {dollars(chart.change_usd)} ({chart.change_percent}%) over five minutes
      </p>
      <svg
        viewBox="0 0 506 180"
        role="img"
        aria-label="Simulated five-minute BTC/USD price chart, labeled in USD and UTC"
      >
        {[48, 90, 132].map((level) => (
          <line
            key={level}
            x1="25"
            x2="481"
            y1={level}
            y2={level}
            stroke="#35494f"
            strokeDasharray="3 5"
          />
        ))}
        <polygon points={'48,145 ' + path + ' 458,145'} fill="#a8ebc9" opacity=".07" />
        <polyline
          points={path}
          fill="none"
          stroke="#a8ebc9"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {chart.points.map((p, i) => (
          <g key={p.time_utc}>
            {chart.selected.time_utc === p.time_utc && (
              <circle cx={x(i)} cy={y(p.price_usd)} r="10" fill="#a8ebc9" opacity=".3" />
            )}
            <circle cx={x(i)} cy={y(p.price_usd)} r="4" fill="#a8ebc9" />
            <text x={x(i)} y={y(p.price_usd) - 15}>
              {dollars(p.price_usd)}
            </text>
            <text x={x(i)} y="167" className="chart-time">
              {p.time_utc}
            </text>
          </g>
        ))}
      </svg>
      <div className="chart-stats">
        {[
          ['Open', chart.open_usd],
          ['Low', chart.low_usd],
          ['High', chart.high_usd],
        ].map(([name, value]) => (
          <div key={name}>
            <span>{name}</span>
            <strong>{dollars(Number(value))}</strong>
          </div>
        ))}
      </div>
      <div className="chart-actions">
        <button className="secondary" onClick={() => act('explore')}>
          Explore chart
        </button>
        <button onClick={() => act('buy')}>Preview buy</button>
        <button className="sell" onClick={() => act('sell')}>
          Preview sell
        </button>
      </div>
      <div aria-live="polite" className="chart-feedback">
        {chart.update > 0 && (
          <p>
            {message} · Update {chart.update}
          </p>
        )}
        {chart.action === 'explore' && <p>Selected price {dollars(chart.selected.price_usd)}</p>}
        {chart.preview && (
          <div className="preview-detail">
            <p>
              <strong>{chart.preview.side === 'buy' ? 'Buy' : 'Sell'} BTC/USD</strong> at{' '}
              {dollars(chart.preview.price_usd)} · Preview only
            </p>
            <button className="secondary" onClick={() => act('cancel')}>
              Cancel preview
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

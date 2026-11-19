import { expect, it } from 'vitest';
import { parse } from 'yaml';
import contractYaml from '../contracts/api.yaml?raw';
import { applyChartAction, initialChart } from './demoChart';

it('uses the frozen event quotes and preview payloads independently of the BTC chart price', () => {
  const api = parse(contractYaml);
  const fixture = api['x-browser-tools'].explore_demo_chart.fixture;
  const event = api['x-simulated-catalog'].gemini_prediction.find(
    (item: { instrument: string }) => item.instrument === fixture.contract.instrument,
  );
  expect(initialChart.contract).toEqual(fixture.contract);
  expect(event).toMatchObject({
    yes_bid: initialChart.contract.yes_bid,
    yes_ask: initialChart.contract.yes_ask,
    no_bid: initialChart.contract.no_bid,
    no_ask: initialChart.contract.no_ask,
  });
  expect(initialChart.points).toEqual(fixture.points);
  for (const side of ['yes', 'no'] as const) {
    const result = applyChartAction(initialChart, side);
    expect(result.underlying_unit).toBe(fixture.underlying_unit);
    expect(result.last_usd).toBe(fixture.last_usd);
    expect(result.preview).toEqual(fixture.previews[side]);
    expect(applyChartAction(result, 'explore').preview).toEqual(result.preview);
  }
});

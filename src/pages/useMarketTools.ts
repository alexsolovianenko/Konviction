import { useRef, useState } from 'react';
import type { MarketContract, MarketEvent, NativeCombo } from '../components/console/types';

export type TrackedContract = { outcome?: 'yes' | 'no' | null; eventTicker: string; symbol: string; title: string; label: string | null };
export type WindowInfo = { event_ticker: string; contract_symbol: string; title: string; label: string | null; expiry: string; seconds_to_expiry: number; market_state: string };
export type Liquidity = {
  outcome: 'yes' | 'no'; side: 'buy' | 'sell'; quantity: number | null; limit_price: number | null;
  snapshot_only: true; depth_unknown: boolean; spread: number | null; displayed_quantity: number | null;
  estimated_executable_quantity: number | null; estimated_average_price: number | null;
};
export type MarketResult = { ok: boolean; liquidity?: Liquidity; error?: string; event_ticker?: string; track_group?: boolean; combos?: NativeCombo[]; listings_checked?: number;
  timing?: { tracked_outcome?: 'yes' | 'no' | null; selected_event_ticker?: string | null; imminent: boolean; current: WindowInfo | null; next_window: WindowInfo | null }[]; events?: MarketEvent[]; title?: string; contract?: MarketContract; as_of?: string };
export type Lookup = { id: number; name: string; params: Record<string, unknown>; result: MarketResult; received: string };
export type MarketTools = ReturnType<typeof useMarketTools>;
export type SelectedMarket = { eventTicker: string; symbol: string };

export function marketTarget(value: MarketResult, query?: unknown): SelectedMarket | null {
  if (!value.ok || value.track_group) return null;
  if (value.event_ticker && value.contract?.symbol)
    return { eventTicker: value.event_ticker, symbol: value.contract.symbol };
  const events = value.events;
  const first = events?.[0];
  const timed = value.timing?.[0]?.current;
  if (timed && value.timing?.length === 1)
    return { eventTicker: timed.event_ticker, symbol: timed.contract_symbol };
  const recurring = /\b(?:five|5)[ -]?(?:minutes?|mins?|m)\b/i.test(String(query ?? ''));
  if (first?.contracts.length === 1 && (events?.length === 1 || recurring))
    return { eventTicker: first.ticker, symbol: first.contracts[0]!.symbol };
  return null;
}

export function useMarketTools(onSelect?: (value: SelectedMarket | null) => void) {
  const [selected, setSelected] = useState<SelectedMarket | null>(null);
  const current = useRef<SelectedMarket | null>(null);
  function select(value: SelectedMarket | null, force = false) {
    if (!force && current.current?.eventTicker === value?.eventTicker && current.current?.symbol === value?.symbol) return;
    current.current = value;
    setSelected(value);
    onSelect?.(value);
  }
  const [result, setResult] = useState<MarketResult>();
  const [tracked, setTracked] = useState<TrackedContract[]>([]);
  const [busy, setBusy] = useState(false);
  // The lookup currently in flight, so the status bubble can name what is actually being fetched.
  const [pending, setPending] = useState<{ name: string; params: Record<string, unknown> } | null>(null);
  const [history, setHistory] = useState<Lookup[]>([]);
  const sequence = useRef(0);
  const epoch = useRef(0);
  function reset() {
    epoch.current++;
    select(null);
    setResult(undefined);
    setTracked([]);
    setHistory([]);
    setPending(null);
    setBusy(false);
  }
  async function run(name: 'search_markets' | 'get_orderbook', params: Record<string, unknown>) {
    const sessionEpoch = epoch.current;
    const id = ++sequence.current;
    const sameQuote = name === 'get_orderbook' && current.current &&
      params['event_ticker'] === current.current.eventTicker && params['contract_symbol'] === current.current.symbol;
    if (!sameQuote) {
      select(null, true);
      setResult(undefined);
    }
    setBusy(true);
    setPending({ name, params });
    let value: MarketResult;
    try {
      const keys = name === 'search_markets' ? ['query'] : ['event_ticker', 'contract_symbol'];
      const optional = name === 'get_orderbook' ? ['side', 'outcome', 'quantity', 'limit_price'] : [];
      if (keys.some(k => typeof params[k] !== 'string') || Object.entries(params).some(([k, v]) =>
        ![...keys, ...optional].includes(k) || (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))))) {
        throw new Error('Invalid market tool parameters.');
      }
      const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
      const response = await fetch('/api/public/market-tools/' + name + '?' + query, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      value = await response.json();
      if (typeof value?.ok !== 'boolean') throw new Error('Unexpected market response.');
    } catch (e) {
      value = { ok: false, error: e instanceof Error && e.message === 'Invalid market tool parameters.' ? e.message : 'Gemini Sandbox market data unavailable.' };
    }
    const superseded = { ok: false, error: 'A newer market selection replaced this lookup.' };
    if (sessionEpoch !== epoch.current) return superseded;
    const entry = { id, name, params, result: value, received: new Date().toISOString() };
    setHistory(previous => [entry, ...previous].sort((a, b) => b.id - a.id).slice(0, 20));
    if (id === sequence.current) {
      if (name === 'get_orderbook' && value.ok &&
          (value.event_ticker !== params['event_ticker'] || value.contract?.symbol !== params['contract_symbol'])) {
        value = { ok: false, error: 'Quote did not match the selected market.' };
      }
      const target = marketTarget(value, params['query']);
      if (target) select(target);
      setResult(value);
      setBusy(false);
      setPending(null);
      if (value.track_group && value.events) {
        setTracked(value.events.flatMap(e => e.contracts.map(c => ({
          eventTicker: e.ticker, symbol: c.symbol, title: e.title, label: c.label,
          outcome: value.timing?.find(w => w.selected_event_ticker === e.ticker)?.tracked_outcome ?? null,
        }))));
      }
    }
    return id === sequence.current ? value : superseded;
  }
  function track(item: TrackedContract) {
    setTracked(current => current.some(c => c.symbol === item.symbol) || current.length >= 6 ? current : [...current, item]);
  }
  function untrack(symbol: string) { setTracked(current => current.filter(c => c.symbol !== symbol)); }
  return { selected, select, tracked, track, untrack, run, result, busy, pending, history, reset, epoch: epoch.current };
}

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
export function useMarketTools() {
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
    setResult(undefined);
    setTracked([]);
    setHistory([]);
    setPending(null);
    setBusy(false);
  }
  async function run(name: 'search_markets' | 'get_orderbook', params: Record<string, unknown>) {
    const sessionEpoch = epoch.current;
    const id = ++sequence.current;
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
    if (sessionEpoch !== epoch.current) return value;
    const entry = { id, name, params, result: value, received: new Date().toISOString() };
    setHistory(previous => [entry, ...previous].sort((a, b) => b.id - a.id).slice(0, 20));
    if (id === sequence.current) {
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
    return value;
  }
  function track(item: TrackedContract) {
    setTracked(current => current.some(c => c.symbol === item.symbol) || current.length >= 6 ? current : [...current, item]);
  }
  function untrack(symbol: string) { setTracked(current => current.filter(c => c.symbol !== symbol)); }
  return { tracked, track, untrack, run, result, busy, pending, history, reset, epoch: epoch.current };
}

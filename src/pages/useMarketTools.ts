import { useRef, useState } from 'react';
import type { MarketContract, MarketEvent } from '../components/console/types';

export type MarketResult = { ok: boolean; error?: string; events?: MarketEvent[]; title?: string; contract?: MarketContract; as_of?: string };
export type Lookup = { id: number; name: string; params: Record<string, unknown>; result: MarketResult; received: string };
export type MarketTools = ReturnType<typeof useMarketTools>;
export function useMarketTools() {
  const [result, setResult] = useState<MarketResult>();
  const [busy, setBusy] = useState(false);
  // The lookup currently in flight, so the status bubble can name what is actually being fetched.
  const [pending, setPending] = useState<{ name: string; params: Record<string, unknown> } | null>(null);
  const [history, setHistory] = useState<Lookup[]>([]);
  const sequence = useRef(0);
  const epoch = useRef(0);
  function reset() {
    epoch.current++;
    setResult(undefined);
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
      if (Object.keys(params).length !== keys.length || keys.some(k => typeof params[k] !== 'string')) {
        throw new Error('Invalid market tool parameters.');
      }
      const query = new URLSearchParams(params as Record<string, string>);
      const response = await fetch('/api/public/market-tools/' + name + '?' + query, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      value = await response.json();
      if (typeof value?.ok !== 'boolean') throw new Error('Unexpected market response.');
    } catch (e) {
      value = { ok: false, error: e instanceof Error && e.message === 'Invalid market tool parameters.' ? e.message : 'Gemini Sandbox market data unavailable.' };
    }
    if (sessionEpoch !== epoch.current) return value;
    const entry = { id, name, params, result: value, received: new Date().toISOString() };
    setHistory(previous => [entry, ...previous].sort((a, b) => b.id - a.id).slice(0, 20));
    if (id === sequence.current) { setResult(value); setBusy(false); setPending(null); }
    return value;
  }
  return { run, result, busy, pending, history, reset, epoch: epoch.current };
}

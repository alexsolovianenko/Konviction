import { useRef, useState } from 'react';
import type { MarketContract, MarketEvent } from '../components/console/types';

type Result = { ok: boolean; error?: string; events?: MarketEvent[]; title?: string; contract?: MarketContract; as_of?: string };
export function useMarketTools() {
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  async function run(name: 'search_markets' | 'get_orderbook', params: Record<string, unknown>) {
    const id = ++sequence.current;
    setBusy(true);
    let value: Result;
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
    if (id === sequence.current) { setResult(value); setBusy(false); }
    return value;
  }
  return { run, result, busy };
}

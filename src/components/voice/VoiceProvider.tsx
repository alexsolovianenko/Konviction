import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMarketTools, type MarketTools } from '../../pages/useMarketTools';
import { Voice, initial, type VoiceView } from '../../voice';
import { workerTrading } from '../../browserTrading';

export type Phase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'lookup'
  | 'ending'
  | 'error';

export type VoiceStatus = { phase: Phase; label: string; detail: string };
type VoiceContext = { view: VoiceView; voice: Voice; market: MarketTools; status: VoiceStatus };

const Context = createContext<VoiceContext | null>(null);

// Everything here is derived from real session events: the SDK mode, the lookup in flight,
// and the transcript. "Thinking" means the last finished turn is the user's (or a tool result)
// and the assistant has not started its reply.
export function deriveStatus(view: VoiceView, market: Pick<MarketTools, 'pending'>): VoiceStatus {
  const last = view.entries.at(-1);
  const live = !['Idle', 'Ending session'].includes(view.status);
  if (market.pending) {
    const { name, params } = market.pending;
    const subject = String(params['query'] || params['contract_symbol'] || '');
    return {
      phase: 'lookup',
      label: name === 'search_markets' ? 'Searching markets' : 'Fetching quote',
      detail: subject ? `Gemini Sandbox · ${subject}` : 'Gemini Sandbox · all events',
    };
  }
  if (view.status === 'Ending session') return { phase: 'ending', label: 'Ending session', detail: 'Closing the voice connection' };
  if (view.status === 'Requesting microphone') return { phase: 'connecting', label: 'Requesting microphone', detail: 'Allow microphone access to continue' };
  if (view.status === 'Connecting') return { phase: 'connecting', label: 'Connecting', detail: 'Opening a voice session' };
  if (view.status === 'Speaking') return { phase: 'speaking', label: 'Speaking', detail: view.draft || 'Assistant is answering' };
  if (live && !view.draft && last && last.role !== 'agent')
    return {
      phase: 'thinking',
      label: 'Thinking',
      detail: last.role === 'user' ? `“${last.text}”` : `Reading ${last.tool_name ?? 'tool'} result`,
    };
  if (live) return { phase: 'listening', label: 'Listening', detail: view.draft || 'Ask about a prediction market' };
  if (view.error) return { phase: 'error', label: 'Voice stopped', detail: 'Press the button to try again' };
  return {
    phase: 'idle',
    label: 'Voice is off',
    detail: view.entries.length ? `Session ended · ${view.entries.length} transcript entries` : 'Press the button to start talking',
  };
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const voiceRef = useRef<Voice | null>(null);
  const market = useMarketTools(target => voiceRef.current?.setVisibleContract(target?.eventTicker, target?.symbol));
  const [view, setView] = useState(initial);
  const [voice] = useState(
    () => new Voice((patch) => setView((previous) => ({ ...previous, ...patch })), market.run, market.select),
  );
  useEffect(() => {
    voiceRef.current = voice;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const token = hash.get('pair');
    if (token && !workerTrading) {
      hash.delete('pair');
      const rest = hash.toString();
      window.history.replaceState(window.history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
      void voice.pairDevice({pairing_token:token});
    }
    const close = () => {
      void voice.stop();
    };
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      close();
    };
  }, [voice]);
  const status = useMemo(() => deriveStatus(view, market), [view, market]);
  return <Context.Provider value={{ view, voice, market, status }}>{children}</Context.Provider>;
}

export const useVoiceContext = () => useContext(Context);
export function useVoice() {
  const value = useContext(Context);
  if (!value) throw new Error('useVoice must be used inside VoiceProvider');
  return value;
}

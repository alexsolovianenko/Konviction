import { useEffect, useRef } from 'react';
import { useVoice } from '../components/voice/VoiceProvider';
import { ActivityPanel } from '../components/voice/ActivityPanel';
import { PredictionPanel } from '../components/prediction/PredictionPanel';

export function Home() {
  const { voice, view, status, market } = useVoice();
  const orb = useRef<HTMLSpanElement>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const turns = view.entries.filter(entry => entry.role !== 'tool');
  useEffect(() => {
    const list = transcript.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns.length, view.draft]);
  const idle = view.status === 'Idle';
  const speaking = view.status === 'Speaking';
  useEffect(() => {
    const el = orb.current;
    if (!el || !speaking || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame: number;
    const draw = () => {
      el.style.setProperty('--amplitude', String(Math.min(1, Math.max(0, voice.outputLevel()))));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(frame); el.style.removeProperty('--amplitude'); };
  }, [speaking, voice]);

  return (
    <section className="voice-canvas" aria-label="Voice workspace">
      <h1 className="sr-only">Talk to the market</h1>
      <button type="button" className="voice-trigger"
        aria-label={idle ? 'Start voice' : 'End session'}
        disabled={view.status === 'Ending session'}
        onClick={() => void (idle ? voice.start() : voice.stop())}>
        <span className="ink-orb" ref={orb} data-phase={speaking ? 'speaking' : status.phase} aria-hidden="true"><i /></span>
        <span>{idle ? 'Start voice' : 'End session'}</span>
      </button>
      {!idle && <p className="voice-state" role="status">{status.label}</p>}
      {view.error && <p className="voice-state" role="alert">{view.error}</p>}
      <PredictionPanel />
      {(!idle || turns.length > 0 || view.draft) && <section className="voice-transcript" aria-label="Live transcript">
        <h2>Live transcript</h2>
        <ol ref={transcript} role="log" aria-live="polite">
          {turns.map(turn => <li key={turn.seq}><strong>{turn.role === 'user' ? 'You' : 'Assistant'}</strong><span>{turn.text}{turn.interrupted && ' (interrupted)'}</span></li>)}
          {view.draft && <li><strong>Assistant</strong><span>{view.draft}</span></li>}
        </ol>
      </section>}
      {market.result && <section className="home-results">
        {market.result.error && <p role="alert">{market.result.error}</p>}
        {market.result.events?.length === 0 && <p>No matching markets.</p>}
        {market.result.events?.map(event => <details key={event.ticker}><summary>{event.title}</summary>
          {event.contracts.map(contract => <button key={contract.symbol} onClick={() => void market.run('get_orderbook', {event_ticker:event.ticker,contract_symbol:contract.symbol})}>{contract.label || contract.symbol}</button>)}</details>)}
        {market.result.contract && <p>{market.result.title} · {market.result.contract.label} · {(['yes','no'] as const).map(side => {
          const price = market.result?.contract?.buy[side];
          return side.toUpperCase() + ' ' + (price == null ? 'unavailable' : Math.round(price * 100) + '¢');
        }).join(' / ')}</p>}
      </section>}
      {(market.history.length > 0 || view.entries.some(entry => entry.role === 'tool')) && <details><summary>Session activity</summary><ActivityPanel /></details>}
    </section>
  );
}

import { useEffect, useRef } from 'react';
import { useVoice } from '../components/voice/VoiceProvider';
import { MarketDiscoveryPanel } from '../components/prediction/MarketDiscoveryPanel';
import { ActivityPanel } from '../components/voice/ActivityPanel';
import { PredictionPanel } from '../components/prediction/PredictionPanel';

export function Home() {
  const { voice, view, status, market, mommyMode, setMommyMode } = useVoice();
  const orb = useRef<HTMLSpanElement>(null);
  const turns = view.entries.filter(entry => entry.role !== 'tool');
  const caption = view.draft || turns.at(-1)?.text;
  const idle = view.status === 'Idle';
  const speaking = view.status === 'Speaking';
  useEffect(() => {
    const el = orb.current;
    if (!el || !speaking || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame: number;
    let level = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const target = Math.min(1, Math.max(0, voice.outputLevel()));
      level += (target - level) * (1 - Math.exp(-(now - last) / 95));
      last = now;
      el.style.transform = 'scale(' + (1 + level * 0.14).toFixed(4) + ')';
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); el.style.removeProperty('transform'); };
  }, [speaking, voice]);

  return (
    <section className="voice-canvas" aria-label="Voice workspace">
      <h1 className="sr-only">Voice workspace</h1>
      <div className="home-voice-card">
        <button type="button" className="voice-trigger"
          aria-label={idle ? 'Start voice' : 'End session'}
          title={idle ? 'Start voice' : 'End session'}
          disabled={view.status === 'Ending session'}
          onClick={() => {
            if (idle) {
              market.reset();
              void voice.start(mommyMode);
            } else void voice.stop();
          }}>
          <span className="ink-orb" ref={orb} data-phase={speaking ? 'speaking' : status.phase} aria-hidden="true"><i /></span>
          <span>{idle ? 'Start voice' : status.phase === 'listening' ? 'Listening to your market request' : status.label}</span>
        </button>
        <p className="home-caption" aria-label="Latest transcript" aria-live="polite">
          {caption || (idle ? 'Tap the orb to talk about a prediction market.' : 'Your words will appear here.')}
        </p>
        <div className="home-wave bars" data-live={!idle && ['speaking','listening'].includes(status.phase)} aria-hidden="true">
          {[7, 13, 9, 20, 26, 16, 22, 12, 8].map((height, i) => <i key={i} style={{height, animationDelay: (i * -.14) + 's'}} />)}
        </div>
        {view.error && <p className="voice-state" role="alert">{view.error}</p>}
      </div>
      <button type="button" className="mommy-mode" aria-pressed={mommyMode} disabled={!idle}
        title={idle ? 'Ivanna · slower speech and gentle encouragement' : 'End the call to change voice mode'}
        onClick={() => setMommyMode(!mommyMode)}>
        <span aria-hidden="true">{mommyMode ? '♥' : '♡'}</span> Mommy mode
      </button>
      <PredictionPanel key={market.selected?.symbol} />
      <MarketDiscoveryPanel />
      {turns.length > 0 && <details className="voice-transcript"><summary>Full transcript</summary>
        <ol>{turns.map(turn => <li key={turn.seq}><strong>{turn.role === 'user' ? 'You' : 'Assistant'}</strong><span>{turn.text}{turn.interrupted && ' (interrupted)'}</span></li>)}</ol>
      </details>}
      {(market.result?.events || market.result?.error) && <section className="home-results">
        {market.result.error && <p role="alert">{market.result.error}</p>}
        {market.result.events?.length === 0 && <p>No matching markets.</p>}
        {market.result.events?.map(event => <details key={event.ticker}><summary>{event.title}</summary>
          {event.contracts.map(contract => <button key={contract.symbol} onClick={() => void market.run('get_orderbook', {event_ticker:event.ticker,contract_symbol:contract.symbol})}>{contract.label || contract.symbol}</button>)}</details>)}
      </section>}
      {(market.history.length > 0 || view.entries.some(entry => entry.role === 'tool')) && <details><summary>Session activity</summary><ActivityPanel /></details>}
    </section>
  );
}

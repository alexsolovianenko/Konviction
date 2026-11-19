import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Square } from 'lucide-react';
import { useVoice } from '../components/voice/VoiceProvider';
import { ActivityPanel } from '../components/voice/ActivityPanel';
import { TradeApproval } from './TradeApproval';

export function Home() {
  const { voice, view, status, market } = useVoice();
  const [query, setQuery] = useState('');
  const orb = useRef<HTMLDivElement>(null);
  const idle = view.status === 'Idle';
  const speaking = view.status === 'Speaking';
  const turns = view.entries.filter(entry => entry.role !== 'tool');
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
      <div className="ink-orb" ref={orb} data-phase={speaking ? 'speaking' : status.phase} aria-hidden="true"><i /></div>
      <form className="voice-composer" onSubmit={e => {
        e.preventDefault();
        if (query.trim() && !market.busy) void market.run('search_markets', { query: query.trim() });
      }}>
        <input aria-label="Search prediction markets" placeholder="Search a prediction market…" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="composer-actions">
          <span role="status">{idle && !market.busy ? 'Gemini Sandbox' : status.label}</span>
          {query.trim() && <button aria-label="Search markets" title="Search markets" disabled={market.busy}><ArrowUp size={17} /></button>}
          <button type="button" aria-label={idle ? 'Start voice' : 'End session'} title={idle ? 'Start voice' : 'End session'}
            disabled={view.status === 'Ending session'} onClick={() => void (idle ? voice.start() : voice.stop())}>
            {idle ? <Mic size={16} /> : <Square size={14} fill="currentColor" />}
          </button>
        </div>
      </form>
      {view.error && <p role="alert">{view.error}</p>}
      {(turns.length > 0 || view.draft) && <div className="conversation-lines" role="log">
        {turns.map(turn => <p key={turn.seq}><b>{turn.role === 'user' ? 'You' : 'Assistant'}</b>{turn.text}{turn.interrupted && ' (interrupted)'}</p>)}
        {view.draft && <p><b>Assistant</b>{view.draft}</p>}
      </div>}
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
      {(view.proposal || view.tradeMessage) && <TradeApproval proposal={view.proposal} availability={view.availability} message={view.tradeMessage} approve={(id,pin) => voice.approve(id,pin)} />}
      {(market.history.length > 0 || view.entries.some(entry => entry.role === 'tool')) && <details><summary>Session activity</summary><ActivityPanel /></details>}
    </section>
  );
}

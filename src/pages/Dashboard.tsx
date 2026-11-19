import { TradeApproval } from './TradeApproval';
import { useEffect, useState } from 'react';
import { useMarketTools } from './useMarketTools';
import { Voice, initial } from '../voice';

export function Dashboard({ focused = false }: { focused?: boolean } = {}) {
  const market = useMarketTools();
  const [query, setQuery] = useState('');
  const [view, setView] = useState(initial);
  const [voice] = useState(
    () => new Voice((patch) => setView((previous) => ({ ...previous, ...patch })), market.run),
  );
  useEffect(() => {
    const close = () => {
      void voice.stop();
    };
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      close();
    };
  }, [voice]);
  return (
    <section className={focused ? "voice-panel panel focused-voice" : "voice-panel panel"}>
      <header>
        {focused ? <><a href="/">← Full console</a><h1>Talk to the market</h1></> : <><h2>Browser voice</h2><a href="/voice">Open focused voice page →</a></>}
        <p>Ask about Gemini Sandbox prediction markets by voice and get a buy proposal. Nothing is sent to Gemini until you approve the exact proposal here with your typed PIN.</p>
      </header>
      <section aria-label="Voice controls" className="controls">
        <button disabled={view.status !== 'Idle'} onClick={() => void voice.start()}>
          Start Voice
        </button>
        <button
          className="secondary"
          disabled={['Idle', 'Ending session'].includes(view.status)}
          onClick={() => void voice.stop()}
        >
          End Session
        </button>
        <span role="status">Microphone · {view.status}</span>
        {view.error && <p role="alert">{view.error}</p>}
      </section>
      <TradeApproval proposal={view.proposal} availability={view.availability} message={view.tradeMessage}
        approve={(id,pin) => voice.approve(id,pin)} />
      <div className="panels">
        <section aria-label="Gemini market tools">
          <h2>{focused ? 'Gemini Sandbox data' : 'Search prediction markets'}</h2>
          {focused && !market.history.length && <p>Ask about a prediction market to see the lookup here, or search below.</p>}
          <form onSubmit={e => { e.preventDefault(); void market.run('search_markets', { query }); }}>
            <input aria-label="Market search" placeholder="Event, ticker, or category" value={query} onChange={e => setQuery(e.target.value)} />
            <button>Search markets</button>
          </form>
          {market.busy && <p role="status">Refreshing Gemini Sandbox…</p>}
          {market.result && <div aria-live="polite">
            {market.result.error && <p role="alert">{market.result.error}</p>}
            {market.result.events?.length === 0 && <p>No matching events in the current sandbox listing.</p>}
            {market.result.events?.map(e => <details open key={e.ticker}><summary>{e.title} · {e.ticker}</summary>
              {e.contracts.map(c => <button key={c.symbol} onClick={() => void market.run('get_orderbook', { event_ticker: e.ticker, contract_symbol: c.symbol })}>Quote {c.label ?? c.symbol}</button>)}</details>)}
            {market.result.contract && <div><strong>{market.result.title} · {market.result.contract.label}</strong><p>{market.result.contract.symbol}</p>
              {(['yes','no'] as const).map(side => <p key={side}>{side.toUpperCase()} · {(['buy','sell'] as const).map(action => {
                const price = market.result!.contract![action][side];
                return action + ' ' + (price === null ? 'unavailable' : (100 * price).toFixed(0) + '¢');
              }).join(' · ')}</p>)}</div>}
            {market.result.as_of && <small>Gemini Sandbox · {market.result.as_of}</small>}
          </div>}
          {focused && market.history.length > 0 && <section className="lookup-history">
            <h3>Lookup history</h3>
            {market.history.map(item => <details key={item.id}>
              <summary>{item.name === 'search_markets' ? 'Market search' : 'Contract quote'} · {String(item.params['query'] || item.params['contract_symbol'] || 'All events')} · {item.result.ok ? 'Received' : 'Unavailable'}</summary>
              <small>{item.received}</small>
              <pre>{JSON.stringify({ request: item.params, response: item.result }, null, 2)}</pre>
            </details>)}
          </section>}
        </section>
        <div className="history-panels">
          <section>
            <h2>Live transcript</h2>
            {!view.entries.length && !view.draft && <p>Your conversation will appear here.</p>}
            <ol>
              {view.entries.map((entry) => (
                <li key={entry.seq}>
                  <div>
                    <strong>
                      {entry.tool_name ?? (entry.role === 'agent' ? 'Assistant' : 'You')}
                    </strong>
                    <time dateTime={entry.timestamp}>
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </time>
                  </div>
                  {entry.role === 'tool' ? (
                    <details>
                      <summary>Tool result</summary>
                      <pre>{entry.text}</pre>
                    </details>
                  ) : (
                    <p>
                      {entry.text}
                      {entry.interrupted && <em> (interrupted)</em>}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {view.draft && (
              <p>
                <strong>Assistant</strong> {view.draft}
              </p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

import { useState, type ReactNode } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { TradeApproval } from './TradeApproval';
import { ActivityPanel } from '../components/voice/ActivityPanel';
import { StatusBubble } from '../components/voice/StatusBubble';
import { VoiceButton } from '../components/voice/VoiceButton';
import { VoiceProvider, useVoice, useVoiceContext } from '../components/voice/VoiceProvider';

// The main workspace. Inside the app shell it shares the shell's voice session; rendered alone
// it brings its own session and status bubble. `children` is the primary content (the market list).
export function Dashboard({ children }: { children?: ReactNode } = {}) {
  return useVoiceContext() ? (
    <Workspace>{children}</Workspace>
  ) : (
    <VoiceProvider>
      <div className="space-y-6">
        <StatusBubble />
        <Workspace>{children}</Workspace>
      </div>
    </VoiceProvider>
  );
}

function Workspace({ children }: { children?: ReactNode }) {
  const { view, voice, market } = useVoice();
  const [query, setQuery] = useState('');
  const result = market.result;
  return (
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_21rem] xl:gap-10">
      <div className="flex min-w-0 flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">{children ? 'Prediction markets' : 'Conversation'}</h1>
          <section aria-label="Voice controls" className="flex items-center gap-3">
            <span role="status" className="tnum text-sm text-muted-foreground">
              Microphone · {view.status}
            </span>
            <VoiceButton />
          </section>
        </header>

        {!children && (
          <section aria-label="Conversation history" className="space-y-5 border-y border-border py-6">
            {view.entries.some(entry => entry.role !== 'tool') || view.draft ? (
              <div role="log" aria-live="polite" className="max-h-[48vh] space-y-4 overflow-auto">
                {view.entries.filter(entry => entry.role !== 'tool').map(entry => (
                  <div key={entry.seq}><strong className="text-xs text-muted-foreground">{entry.role === 'user' ? 'You' : 'Assistant'}</strong>
                    <p>{entry.text}{entry.interrupted && <em> (interrupted)</em>}</p></div>
                ))}
                {view.draft && <p>{view.draft}</p>}
              </div>
            ) : (
              <div><h2 className="text-lg font-medium">What market are you following?</h2>
                <p className="mt-1 text-sm text-muted-foreground">Start voice to ask a question, or explore a market below.</p></div>
            )}
            <div className="flex flex-wrap gap-2">
              {[['Bitcoin · 5 minutes', 'five-minute bitcoin'], ['Ethereum', 'ETH'], ['Browse active events', '']].map(([label, term]) => (
                <button key={label} className="btn btn-quiet" onClick={() => { setQuery(term ?? ''); void market.run('search_markets', { query: term ?? '' }); }}>{label}</button>
              ))}
            </div>
          </section>
        )}

        <TradeApproval
          proposal={view.proposal}
          availability={view.availability}
          message={view.tradeMessage}
          approve={(id, pin) => voice.approve(id, pin)}
        />

        {children}
      </div>

      <div className="flex min-w-0 flex-col gap-8 xl:sticky xl:top-20">
        <section aria-label="Gemini market tools" className="min-w-0">
          <h2 className="border-b border-border pb-2 text-sm font-semibold">Search Gemini Sandbox</h2>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void market.run('search_markets', { query });
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                className="field pl-8"
                aria-label="Market search"
                placeholder="Event, ticker, or category"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="btn btn-quiet">Search markets</button>
          </form>
          {market.busy && (
            <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="spinner spinner-ink" aria-hidden /> Refreshing Gemini Sandbox…
            </p>
          )}
          {result && (
            <div aria-live="polite" className="mt-3 space-y-2">
              {result.error && <p role="alert" className="text-sm text-destructive">{result.error}</p>}
              {result.events?.length === 0 && <p className="text-sm text-muted-foreground">No matching events in the current sandbox listing.</p>}
              {result.events?.map((e) => (
                <details open={result.events?.length === 1} key={e.ticker} className="border-b border-border pb-2">
                  <summary className="flex items-start gap-1.5 py-1 text-sm font-medium">
                    <ChevronRight className="chev mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {e.title} · {e.ticker}
                  </summary>
                  <div className="flex flex-wrap gap-1.5 pl-5 pt-1">
                    {e.contracts.map((c) => (
                      <button
                        key={c.symbol}
                        className="btn btn-chip"
                        onClick={() => void market.run('get_orderbook', { event_ticker: e.ticker, contract_symbol: c.symbol })}
                      >
                        Quote {c.label ?? c.symbol}
                      </button>
                    ))}
                  </div>
                </details>
              ))}
              {result.contract && (
                <div className="panel p-3">
                  <strong className="block text-sm font-semibold">
                    {result.title} · {result.contract.label}
                  </strong>
                  <p className="break-all font-mono text-xs text-muted-foreground">{result.contract.symbol}</p>
                  <div className="mt-2 space-y-1">
                    {(['yes', 'no'] as const).map((side) => (
                      <p key={side} className={'font-mono text-sm ' + (side === 'yes' ? 'text-success' : 'text-destructive')}>
                        {side.toUpperCase()} ·{' '}
                        {(['buy', 'sell'] as const)
                          .map((action) => {
                            const price = result.contract![action][side];
                            return action + ' ' + (price === null ? 'unavailable' : (100 * price).toFixed(0) + '¢');
                          })
                          .join(' · ')}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {result.as_of && <small className="tnum block text-xs text-muted-foreground">Gemini Sandbox · {result.as_of}</small>}
            </div>
          )}
        </section>
        <ActivityPanel />
      </div>
    </div>
  );
}

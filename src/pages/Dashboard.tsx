import { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { TradeApproval } from './TradeApproval';
import { ActivityPanel } from '../components/voice/ActivityPanel';
import { StatusBubble } from '../components/voice/StatusBubble';
import { VoiceButton } from '../components/voice/VoiceButton';
import { VoiceProvider, useVoice, useVoiceContext } from '../components/voice/VoiceProvider';

const hints: Record<string, string> = {
  idle: 'Press to open a voice session. Your microphone is only used while it is on.',
  error: 'Press to try again.',
  connecting: 'Getting ready…',
  listening: 'Go ahead. Ask about a Gemini Sandbox prediction market.',
  thinking: 'Working on your request.',
  speaking: 'Speak at any time to interrupt.',
  lookup: 'Reading fresh data from Gemini Sandbox.',
  ending: 'Closing the session.',
};

// The voice workspace. Inside the app shell it shares the shell's voice session; rendered alone
// it brings its own session and status bubble.
export function Dashboard() {
  return useVoiceContext() ? (
    <Workspace />
  ) : (
    <VoiceProvider>
      <div className="space-y-6">
        <StatusBubble />
        <Workspace />
      </div>
    </VoiceProvider>
  );
}

function Workspace() {
  const { view, voice, market, status } = useVoice();
  const [query, setQuery] = useState('');
  const result = market.result;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem] xl:gap-8">
      <div className="flex min-w-0 flex-col gap-6">
        <section
          aria-label="Voice controls"
          className="stage grid items-center gap-8 px-6 py-10 text-center sm:px-10 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10 md:py-12 md:text-left lg:px-14"
        >
          <div className="min-w-0">
            <h1 className="display text-[2.75rem] sm:text-6xl lg:text-[4.5rem]">Talk to the market.</h1>
            <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-muted-foreground md:mx-0 md:text-lg">
              Explore Gemini Sandbox prediction contracts by voice. Review a buy proposal here and approve it with your private PIN.
            </p>
            <div className="mt-7 flex flex-col items-center gap-2 md:items-start">
              <span role="status" className="tnum inline-flex items-center rounded-full bg-background px-4 py-2 text-sm font-semibold">
                Microphone · {view.status}
              </span>
              <p className="text-sm text-muted-foreground">{hints[status.phase]}</p>
            </div>
          </div>
          <div className="mx-auto"><VoiceButton /></div>
        </section>

        <TradeApproval
          proposal={view.proposal}
          availability={view.availability}
          message={view.tradeMessage}
          approve={(id, pin) => voice.approve(id, pin)}
        />

        <section aria-label="Gemini market tools" className="panel min-w-0 overflow-hidden">
          <header className="px-5 pb-5 pt-6 sm:px-7">
            <h2 className="text-xl font-semibold tracking-tight">Search prediction markets</h2>
            <p className="mt-1 text-sm text-muted-foreground">The same Gemini Sandbox lookups the voice assistant uses.</p>
            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void market.run('search_markets', { query });
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  className="field pl-10"
                  aria-label="Market search"
                  placeholder="Event, ticker, or category"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button className="btn btn-ink h-12 px-6">Search markets</button>
            </form>
          </header>
          {market.busy && (
            <p role="status" className="flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-muted-foreground sm:px-7">
              <span className="spinner spinner-ink" aria-hidden /> Refreshing Gemini Sandbox…
            </p>
          )}
          {!result && !market.busy && (
            <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground sm:px-7">
              Ask about a prediction market to see the lookup here, or search above.
            </p>
          )}
          {result && (
            <div aria-live="polite" className="space-y-3 border-t border-border px-5 py-5 sm:px-7">
              {result.error && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{result.error}</p>}
              {result.events?.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No matching events in the current sandbox listing.</p>}
              {result.events?.map((e) => (
                <details open key={e.ticker} className="rounded-2xl bg-muted">
                  <summary className="flex items-center gap-2 px-4 py-3 text-sm font-semibold">
                    <ChevronRight className="chev size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {e.title} · {e.ticker}
                  </summary>
                  <div className="flex flex-wrap gap-2 px-4 pb-4">
                    {e.contracts.map((c) => (
                      <button
                        key={c.symbol}
                        className="btn btn-chip bg-background hover:bg-primary-soft"
                        onClick={() => void market.run('get_orderbook', { event_ticker: e.ticker, contract_symbol: c.symbol })}
                      >
                        Quote {c.label ?? c.symbol}
                      </button>
                    ))}
                  </div>
                </details>
              ))}
              {result.contract && (
                <div className="rounded-2xl bg-muted p-5">
                  <strong className="block text-lg font-semibold tracking-tight">
                    {result.title} · {result.contract.label}
                  </strong>
                  <p className="break-all font-mono text-xs text-muted-foreground">{result.contract.symbol}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {(['yes', 'no'] as const).map((side) => (
                      <p
                        key={side}
                        className={'tnum rounded-xl bg-background px-4 py-3 text-base font-semibold ' + (side === 'yes' ? 'text-success' : 'text-destructive')}
                      >
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
      </div>
      <ActivityPanel />
    </div>
  );
}

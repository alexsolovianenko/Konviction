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
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <section aria-label="Voice controls" className="panel flex flex-col items-center gap-5 px-5 pb-8 pt-9 text-center sm:pt-11">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Talk to the market</h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Explore Gemini Sandbox prediction contracts by voice. Review a buy proposal here and approve it with your private PIN.
            </p>
          </div>
          <VoiceButton />
          <div className="space-y-1">
            <span role="status" className="tnum inline-flex rounded-full bg-muted px-3 py-1 text-sm font-medium">
              Microphone · {view.status}
            </span>
            <p className="text-sm text-muted-foreground">{hints[status.phase]}</p>
          </div>
        </section>

        <TradeApproval
          proposal={view.proposal}
          availability={view.availability}
          message={view.tradeMessage}
          approve={(id, pin) => voice.approve(id, pin)}
        />

        <section aria-label="Gemini market tools" className="panel min-w-0 overflow-hidden">
          <header className="border-b border-border px-4 py-4 sm:px-5">
            <h2 className="text-base font-semibold tracking-tight">Search prediction markets</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">The same Gemini Sandbox lookups the voice assistant uses.</p>
            <form
              className="mt-3 flex gap-2"
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
              <button className="btn btn-primary">Search markets</button>
            </form>
          </header>
          {market.busy && (
            <p role="status" className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground sm:px-5">
              <span className="spinner spinner-ink" aria-hidden /> Refreshing Gemini Sandbox…
            </p>
          )}
          {!result && !market.busy && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              Ask about a prediction market to see the lookup here, or search above.
            </p>
          )}
          {result && (
            <div aria-live="polite" className="space-y-3 px-4 py-4 sm:px-5">
              {result.error && <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{result.error}</p>}
              {result.events?.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No matching events in the current sandbox listing.</p>}
              {result.events?.map((e) => (
                <details open key={e.ticker} className="rounded-2xl border border-border">
                  <summary className="flex items-center gap-2 px-4 py-3 text-sm font-semibold">
                    <ChevronRight className="chev size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {e.title} · {e.ticker}
                  </summary>
                  <div className="flex flex-wrap gap-2 px-4 pb-4">
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
                <div className="rounded-2xl border border-border p-4">
                  <strong className="block text-base font-semibold">
                    {result.title} · {result.contract.label}
                  </strong>
                  <p className="break-all font-mono text-xs text-muted-foreground">{result.contract.symbol}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {(['yes', 'no'] as const).map((side) => (
                      <p
                        key={side}
                        className={'tnum rounded-xl px-3 py-2.5 text-sm font-semibold ' + (side === 'yes' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}
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

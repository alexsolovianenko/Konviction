import { ChevronRight, FileSearch, LineChart, Wrench } from 'lucide-react';
import { JsonBlock } from '../console/ui';
import { useVoice } from './VoiceProvider';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function pretty(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Right-hand rail: every Gemini Sandbox lookup and capture tool result of this session, newest first,
// each expandable to the exact request and response.
export function ActivityPanel() {
  const { view, market } = useVoice();
  const items = [
    ...market.history.map((item) => ({ at: item.received, key: 'lookup-' + item.id, lookup: item, tool: undefined })),
    ...view.entries
      .filter((entry) => entry.role === 'tool')
      .map((entry) => ({ at: entry.timestamp, key: 'tool-' + entry.seq + entry.timestamp, lookup: undefined, tool: entry })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <aside aria-label="Live activity" className="flex min-w-0 flex-col gap-4">
      <section className="panel flex min-w-0 flex-col overflow-hidden">
        <header className="flex min-h-14 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold tracking-tight">Live activity</h2>
          {market.pending ? (
            <span className="flex items-center gap-2 text-xs font-medium text-accent-foreground">
              <span className="spinner spinner-ink" aria-hidden /> Gemini Sandbox
            </span>
          ) : (
            <span className="tnum text-xs text-muted-foreground">{items.length} {items.length === 1 ? 'event' : 'events'}</span>
          )}
        </header>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-primary-soft text-primary"><FileSearch className="size-5" aria-hidden /></span>
            <p className="text-sm font-medium">Nothing looked up yet</p>
            <p className="text-sm text-muted-foreground">Ask about a prediction market, or search below. Each Gemini Sandbox response lands here so you can open it.</p>
          </div>
        ) : (
          <ul className="lookup-history max-h-[34rem] divide-y divide-border overflow-y-auto">
            {items.map(({ key, lookup, tool, at }) => (
              <li key={key} className="animate-row-in">
                <details className="group">
                  <summary className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60">
                    <span className={'grid size-9 shrink-0 place-items-center rounded-full ' + (lookup ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground')}>
                      {lookup ? (lookup.name === 'search_markets' ? <FileSearch className="size-4" aria-hidden /> : <LineChart className="size-4" aria-hidden />) : <Wrench className="size-4" aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {lookup
                          ? `${lookup.name === 'search_markets' ? 'Market search' : 'Contract quote'} · ${String(lookup.params['query'] || lookup.params['contract_symbol'] || 'All events')}`
                          : tool!.tool_name}
                      </span>
                      <span className="tnum flex items-center gap-1.5 text-xs text-muted-foreground">
                        <time dateTime={at}>{time(at)}</time>
                        <span aria-hidden>·</span>
                        {lookup ? (
                          <span className={lookup.result.ok ? 'font-medium text-success' : 'font-medium text-destructive'}>{lookup.result.ok ? 'Received' : 'Unavailable'}</span>
                        ) : (
                          <span>Capture tool result</span>
                        )}
                      </span>
                    </span>
                    <ChevronRight className="chev size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </summary>
                  <div className="px-4 pb-4">
                    <JsonBlock value={lookup ? { request: lookup.params, response: lookup.result } : pretty(tool!.text)} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel min-w-0 overflow-hidden">
        <header className="flex min-h-14 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold tracking-tight">Captured intents</h2>
          <span className="tnum text-xs text-muted-foreground">{view.intents.length}</span>
        </header>
        {!view.intents.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No intents captured this session.</p>
        ) : (
          <ol className="divide-y divide-border">
            {view.intents.map((intent) => (
              <li key={intent.id} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="font-semibold capitalize">{intent.intent.replace('_', ' ')}</strong>
                  <time className="tnum text-xs text-muted-foreground" dateTime={intent.created_at}>
                    {time(intent.created_at)}
                  </time>
                </div>
                <p className="text-muted-foreground">
                  {intent.venue.replace('_', ' ')} · {intent.instrument || intent.order_id}
                </p>
                {intent.quantity !== null && intent.limit_price !== null && intent.limit_price !== undefined && (
                  <p className="tnum">
                    {intent.quantity} {intent.side?.toUpperCase()}{' '}
                    {intent.quantity === 1 ? 'contract' : 'contracts'} at{' '}
                    {Math.round(intent.limit_price * 100)}¢ each
                  </p>
                )}
                {intent.order_id && intent.instrument && <p className="tnum">Order {intent.order_id}</p>}
                <q className="block text-muted-foreground">{intent.utterance}</q>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

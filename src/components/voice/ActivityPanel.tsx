import { hms } from "../../lib/format";
import { ChevronRight } from 'lucide-react';
import { JsonBlock } from '../console/ui';
import { useVoice } from './VoiceProvider';

function pretty(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Every Gemini Sandbox lookup and capture tool result of this session, newest first,
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
    <aside aria-label="Activity" className="flex min-w-0 flex-col gap-8">
      <section className="min-w-0">
        <header className="flex items-center justify-between gap-2 border-b border-border pb-2">
          <h2 className="text-sm font-semibold">Activity</h2>
          {market.pending && <span className="spinner spinner-ink" aria-label="Fetching from Gemini Sandbox" />}
        </header>
        {items.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">Lookups and tool results appear here with their full Gemini Sandbox response.</p>
        ) : (
          <ul className="lookup-history max-h-[28rem] overflow-y-auto">
            {items.map(({ key, lookup, tool, at }) => (
              <li key={key} className="animate-row-in border-b border-border">
                <details>
                  <summary className="flex items-center gap-2 py-2 hover:bg-card">
                    <ChevronRight className="chev size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {lookup
                          ? `${lookup.name === 'search_markets' ? 'Market search' : 'Contract quote'} · ${String(lookup.params['query'] || lookup.params['contract_symbol'] || 'All events')}`
                          : tool!.tool_name}
                      </span>
                      <span className="tnum flex items-center gap-1.5 text-xs text-muted-foreground">
                        <time dateTime={at}>{hms(at)}</time>
                        <span aria-hidden>·</span>
                        {lookup ? (
                          <span className={lookup.result.ok ? 'text-success' : 'text-destructive'}>{lookup.result.ok ? 'Received' : 'Unavailable'}</span>
                        ) : (
                          <span>Capture tool result</span>
                        )}
                      </span>
                    </span>
                  </summary>
                  <div className="pb-3 pl-6">
                    <JsonBlock value={lookup ? { request: lookup.params, response: lookup.result } : pretty(tool!.text)} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="min-w-0">
        <h2 className="border-b border-border pb-2 text-sm font-semibold">Captured intents</h2>
        {!view.intents.length ? (
          <p className="py-3 text-sm text-muted-foreground">No intents captured this session.</p>
        ) : (
          <ol>
            {view.intents.map((intent) => (
              <li key={intent.id} className="space-y-0.5 border-b border-border py-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="font-medium capitalize">{intent.intent.replace('_', ' ')}</strong>
                  <time className="tnum text-xs text-muted-foreground" dateTime={intent.created_at}>
                    {hms(intent.created_at)}
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

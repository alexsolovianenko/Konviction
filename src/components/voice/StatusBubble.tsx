import { useEffect, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, Mic, MicOff } from 'lucide-react';
import { useVoice, type Phase } from './VoiceProvider';

function Indicator({ phase }: { phase: Phase }) {
  if (phase === 'listening' || phase === 'speaking')
    return (
      <span className="bars" data-live="true" data-fast={phase === 'speaking'} aria-hidden>
        <i /><i /><i /><i />
      </span>
    );
  if (phase === 'thinking') return <span className="dots" aria-hidden><i /><i /><i /></span>;
  if (phase === 'lookup' || phase === 'connecting' || phase === 'ending') return <span className="spinner" aria-hidden />;
  if (phase === 'error') return <CircleAlert className="size-3.5" aria-hidden />;
  return <MicOff className="size-3.5" aria-hidden />;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// The pill at the top of every view. It names what the session is actually doing and opens the transcript.
export function StatusBubble() {
  const { view, status } = useVoice();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLLIElement>(null);
  const turns = view.entries.filter((entry) => entry.role !== 'tool');
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  useEffect(() => {
    if (open) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, turns.length, view.draft]);

  return (
    <div ref={root} className="relative w-full max-w-xl">
      <button
        type="button"
        className="bubble"
        data-phase={status.phase}
        aria-expanded={open}
        aria-controls="voice-transcript"
        title={open ? 'Hide transcript' : 'Show transcript'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="bubble-icon"><Indicator phase={status.phase} /></span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium">{status.label}</span>
          <span className="truncate text-sm text-muted-foreground">{status.detail}</span>
        </span>
        {turns.length > 0 && (
          <span className="tnum hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {turns.length}
          </span>
        )}
        <ChevronDown className={'size-4 shrink-0 text-muted-foreground transition-transform ' + (open ? 'rotate-180' : '')} aria-hidden />
      </button>
      {view.error && (
        <p role="alert" className="absolute inset-x-0 top-full z-40 mt-2 flex items-start gap-2 rounded-lg border border-destructive bg-card px-3 py-2 text-sm text-destructive shadow-lg">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{view.error}</span>
        </p>
      )}
      {open && (
        <section
          id="voice-transcript"
          aria-label="Live transcript"
          className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-lg border border-border-strong bg-card shadow-2xl"
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Transcript</h2>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mic className="size-3.5" aria-hidden /> {view.status}
            </span>
          </header>
          {!turns.length && !view.draft ? (
            <p className="px-3 py-6 text-sm text-muted-foreground">Your conversation will appear here.</p>
          ) : (
            <ol className="max-h-[min(60vh,26rem)] space-y-3 overflow-y-auto px-3 py-3">
              {turns.map((entry) => (
                <li key={entry.seq} className={'flex flex-col ' + (entry.role === 'user' ? 'items-end' : 'items-start')}>
                  <div className={'max-w-[85%] rounded-lg px-3 py-1.5 text-sm leading-relaxed ' + (entry.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-raised')}>
                    {entry.text || <span className="italic opacity-70">No audio was played</span>}
                    {entry.interrupted && <em className="opacity-70"> (interrupted)</em>}
                  </div>
                  <span className="tnum mt-1 px-1 text-[11px] text-muted-foreground">
                    {entry.role === 'user' ? 'You' : 'Assistant'} · <time dateTime={entry.timestamp}>{time(entry.timestamp)}</time>
                  </span>
                </li>
              ))}
              {view.draft && (
                <li className="flex flex-col items-start">
                  <div className="max-w-[85%] rounded-lg border border-dashed border-primary bg-primary-soft px-3 py-1.5 text-sm leading-relaxed">
                    {view.draft}
                  </div>
                  <span className="mt-1 px-1 text-[11px] text-muted-foreground">Assistant · speaking now</span>
                </li>
              )}
              <li ref={end} aria-hidden />
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

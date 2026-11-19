import { useEffect, useState } from "react";
import type { Proposal } from "../../browserTrading";
import { cents, countdown } from "../../lib/format";
import { TradeApproval } from "../../pages/TradeApproval";
import type { Lookup, MarketResult } from "../../pages/useMarketTools";
import { useVoice } from "../voice/VoiceProvider";
import { VoicePositions } from "../voice/VoicePositions";
import { QuoteChart } from "./QuoteChart";
import { SettlementIndexPanel } from "./SettlementIndexPanel";
import { POLL_MS, useContractQuotes, type QuoteTarget } from "./useContractQuotes";

const text = (value: unknown) => (typeof value === "string" && value ? value : null);
// Same phrasing the search route treats as the BTC five-minute series.
const FIVE_MINUTE = /\b(?:five|5)[ -]?(?:minutes?|mins?|m)\b|\b05m\b/i;

/**
 * The contract the panel must show, taken only from identifiers Gemini-backed routes returned:
 * a prepared proposal wins (so the chart always matches what the PIN would approve), then a
 * selected contract quote, then the nearest-expiry match of a five-minute search.
 */
export function selectTarget(
  proposal: Proposal | null,
  result: MarketResult | undefined,
  history: Lookup[],
): QuoteTarget | null {
  const proposed = proposal as (Proposal & { event_ticker?: unknown }) | null;
  if (proposed) {
    const eventTicker = text(proposed.event_ticker);
    return eventTicker ? { eventTicker, symbol: proposed.instrument_symbol } : null;
  }
  if (!result?.ok || result.track_group) return null;
  const quoted = result as MarketResult & { event_ticker?: unknown };
  if (quoted.contract) {
    const eventTicker = text(quoted.event_ticker);
    return eventTicker ? { eventTicker, symbol: quoted.contract.symbol } : null;
  }
  const lookup = history.find((entry) => entry.result === result);
  const event = result.events?.[0];
  if (
    lookup?.name === "search_markets" &&
    FIVE_MINUTE.test(String(lookup.params["query"] ?? "")) &&
    event?.contracts.length === 1
  )
    return { eventTicker: event.ticker, symbol: event.contracts[0]!.symbol };
  return null;
}

/** Live contract chart plus the full typed-PIN purchase panel, driven by the voice session. */
export function PredictionPanel() {
  const { voice, view, market } = useVoice();
  const selected = selectTarget(view.proposal, market.result, market.history);
  // Keep the last selection while unrelated lookups come and go; a proposal always overrides it.
  const [target, setTarget] = useState<QuoteTarget | null>(selected);
  const eventTicker = selected?.eventTicker;
  const symbol = selected?.symbol;
  useEffect(() => {
    if (eventTicker && symbol) setTarget({ eventTicker, symbol });
  }, [eventTicker, symbol]);
  // A proposal without an event ticker may still be charted when it is the contract already open.
  const shown = view.proposal
    ? (selected ?? (target?.symbol === view.proposal.instrument_symbol ? target : null))
    : selected ?? target;
  const visibleEvent = shown?.eventTicker;
  const visibleSymbol = shown?.symbol;
  useEffect(() => {
    voice.setVisibleContract?.(visibleEvent, visibleSymbol);
  }, [voice, visibleEvent, visibleSymbol]);
  useEffect(() => () => voice.setVisibleContract?.(), [voice]);
  const feed = useContractQuotes(shown);
  const [now, setNow] = useState(() => Date.now());
  const expiry = feed.contract?.expiry ?? null;
  useEffect(() => {
    if (!expiry || feed.status === "closed") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiry, feed.status]);

  if (!shown && !view.proposal && !view.tradeMessage && !view.positionSnapshot) return null;
  const latest = feed.contract?.symbol === shown?.symbol ? feed.samples.at(-1) : undefined;
  return (
    <section aria-label="Prediction contract" className="grid min-w-0 gap-4">
      {shown && (
        <>
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="min-w-0 text-lg font-semibold tracking-tight">
              {[feed.title, feed.contract?.label].filter(Boolean).join(" · ") || "Selected contract"}
            </h2>
            <p role="status" className="text-xs text-muted-foreground">
              {feed.status === "live"
                ? "Live · Gemini Sandbox"
                : feed.status === "loading"
                  ? "Loading quote…"
                  : feed.message}
            </p>
          </header>
          <dl className="contract-metrics grid grid-cols-3 gap-2 sm:gap-3">
            {(["yes", "no"] as const).map((side) => (
              <div key={side} className="min-w-0 rounded-xl border border-border bg-card px-3 py-3 sm:px-4">
                <dt className="text-xs text-muted-foreground">{side.toUpperCase()} buy</dt>
                <dd className="tnum mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
                  {cents(latest?.[side])}
                </dd>
              </div>
            ))}
            <div className="min-w-0 rounded-xl border border-border bg-card px-3 py-3 sm:px-4">
              <dt className="text-xs text-muted-foreground">Expires in</dt>
              <dd className="tnum mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
                {feed.status === "closed" ? "Closed" : expiry ? <time dateTime={expiry} title={new Date(expiry).toLocaleString()}>{countdown(expiry, now)}</time> : "—"}
              </dd>
            </div>
          </dl>
          <SettlementIndexPanel eventTicker={shown.eventTicker} />
          <section aria-label="Contract price chart" className="contract-chart min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Contract prices</h3>
              <span className="text-xs text-muted-foreground">Session · {POLL_MS / 1000}s intervals</span>
            </div>
            {feed.samples.length > 0 ? (
              <>
                <QuoteChart samples={feed.samples} />
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Data source</summary>
                  <p className="mt-1">Session-observed Gemini Sandbox YES/NO buy prices. This is not the BTC price or exchange history.</p>
                </details>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {feed.status === "loading" ? "Waiting for the first quote…" : "No quote received for this contract."}
              </p>
            )}
          </section>
        </>
      )}
      {view.proposal && !shown && (
        <p role="alert" className="text-sm text-warning">
          Chart unavailable: the proposal did not name its event.
        </p>
      )}
      <VoicePositions snapshot={view.positionSnapshot} />
      {(view.proposal || view.tradeMessage) && <TradeApproval
        proposal={view.proposal}
        availability={view.availability}
        message={view.tradeMessage}
        pair={(pin) => voice.pairDevice({pin})}
        approve={(id, pin) => voice.approve(id, pin)}
      />}
    </section>
  );
}

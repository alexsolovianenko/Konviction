import { austinDateTime } from "../../lib/format";
import { useEffect, useState } from "react";
import { cents, countdown } from "../../lib/format";
import { TradeApproval } from "../../pages/TradeApproval";
import { useVoice } from "../voice/VoiceProvider";
import { VoicePositions } from "../voice/VoicePositions";
import { QuoteChart } from "./QuoteChart";
import { ResearchCard } from "./ResearchCard";
import { SettlementIndexPanel } from "./SettlementIndexPanel";
import { POLL_MS, useContractQuotes } from "./useContractQuotes";

export function PredictionPanel() {
  const { voice, view, market } = useVoice();
  const shown = market.selected;
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
  // Research is shown only for the exact contract it was identified for (crypto markets only).
  const research = view.research;
  const researchForShown = Boolean(
    research && shown && (research.quote
      ? research.quote.context.market.event_ticker === shown.eventTicker && research.quote.context.market.contract_symbol === shown.symbol
      : research.message),
  );
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
                {feed.status === "closed" ? "Closed" : expiry ? <time dateTime={expiry} title={austinDateTime(expiry)}>{countdown(expiry, now)}</time> : "—"}
              </dd>
            </div>
          </dl>
          <SettlementIndexPanel key={shown.eventTicker} eventTicker={shown.eventTicker} />
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
      {researchForShown && research && <ResearchCard research={research} onRequestQuote={() => void voice.requestResearchQuote()} />}
      {(view.proposal || view.tradeMessage) && <TradeApproval
        proposal={view.proposal}
        availability={view.availability}
        message={view.tradeMessage}
        remainderQuantity={view.remainderQuantity}
        retry={() => voice.prepareRemainderOnScreen()}
      />}
    </section>
  );
}

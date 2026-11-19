import { useEffect, useState } from "react";
import type { Proposal } from "../../browserTrading";
import { cents, countdown } from "../../lib/format";
import { TradeApproval } from "../../pages/TradeApproval";
import type { Lookup, MarketResult } from "../../pages/useMarketTools";
import { useVoice } from "../voice/VoiceProvider";
import { QuoteChart } from "./QuoteChart";
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
  if (!result?.ok) return null;
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
  const [outcome, setOutcome] = useState<"yes" | "no">("yes");
  const [budget, setBudget] = useState("");
  const [preparing, setPreparing] = useState(false);
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
    : target;
  const feed = useContractQuotes(shown);
  const [now, setNow] = useState(() => Date.now());
  const expiry = feed.contract?.expiry ?? null;
  useEffect(() => {
    if (!expiry || feed.status === "closed") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiry, feed.status]);

  if (!shown && !view.proposal && !view.tradeMessage) return null;
  const latest = feed.samples.at(-1);
  return (
    <section aria-label="Prediction contract" className="grid min-w-0 gap-4">
      {shown && (
        <div className="min-w-0 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="min-w-0 text-lg font-semibold tracking-tight">
              {feed.title
                ? `${feed.title} · ${feed.contract?.label ?? shown.symbol}`
                : shown.symbol}
            </h2>
            <p role="status" className="text-xs text-muted-foreground">
              {feed.status === "live"
                ? "Live · Gemini Sandbox"
                : feed.status === "loading"
                  ? "Loading quote…"
                  : feed.message}
            </p>
          </div>
          <p className="tnum mt-0.5 break-words text-xs text-muted-foreground">
            {shown.symbol}
            {expiry && feed.status !== "closed" && ` · Closes in ${countdown(expiry, now)}`}
          </p>
          {latest && (
            <dl className="mt-3 flex gap-8 text-sm">
              {(["yes", "no"] as const).map((side) => (
                <div key={side}>
                  <dt className="text-xs text-muted-foreground">Buy {side.toUpperCase()}</dt>
                  <dd className="mt-0.5 font-mono text-xl">
                    {latest[side] === null ? "unavailable" : cents(latest[side])}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {feed.samples.length > 0 && (
            <div className="mt-3">
              <QuoteChart samples={feed.samples} />
              <p className="mt-2 text-xs text-muted-foreground">
                Session-observed Gemini Sandbox YES/NO buy prices for this contract, sampled about
                every {POLL_MS / 1000} seconds since you opened it. This is not the BTC price and
                not exchange history.
              </p>
            </div>
          )}
          {feed.samples.length === 0 && feed.status !== "loading" && (
            <p className="mt-3 text-sm text-muted-foreground">
              No Gemini Sandbox quote observed for this contract, so there is no chart.
            </p>
          )}
        </div>
      )}
      {view.proposal && !shown && (
        <p role="alert" className="text-sm text-warning">
          Chart unavailable: the proposal did not name its event.
        </p>
      )}
      {shown && !view.proposal && (
        <form aria-label="Prepare sandbox buy" className="flex flex-wrap items-end gap-3" onSubmit={async e => {
          e.preventDefault();
          const price = latest?.[outcome];
          if (preparing || view.status === "Idle" || feed.status !== "live" || price == null || !(Number(budget) > 0)) return;
          setPreparing(true);
          try {
            await voice.prepareBuy({event_ticker:shown.eventTicker, contract_symbol:shown.symbol, outcome, budget_usd:Number(budget), limit_price:price});
          } finally { setPreparing(false); }
        }}>
          <label>Outcome<select className="field" value={outcome} onChange={e => setOutcome(e.target.value === "no" ? "no" : "yes")}><option value="yes">YES</option><option value="no">NO</option></select></label>
          <label>Budget (USD)<input className="field" type="number" min="0.01" step="0.01" required value={budget} onChange={e => setBudget(e.target.value)} /></label>
          <button className="btn btn-primary" disabled={preparing || !["Speaking","Listening"].includes(view.status) || feed.status !== "live" || latest?.[outcome] == null || !(Number(budget)>0)}>
            {preparing ? "Preparing…" : "Preview sandbox buy"}
          </button>
        </form>
      )}
      <TradeApproval
        proposal={view.proposal}
        availability={view.availability}
        message={view.tradeMessage}
        approve={(id, pin) => voice.approve(id, pin)}
      />
    </section>
  );
}

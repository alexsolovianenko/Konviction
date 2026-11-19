import { cents } from "../../lib/format";
import type { TrackedContract } from "../../pages/useMarketTools";
import { useVoice } from "../voice/VoiceProvider";
import { useContractQuotes } from "./useContractQuotes";

function TrackedRow({ item, onRemove }: { item: TrackedContract; onRemove(): void }) {
  const feed = useContractQuotes(item, 15000);
  const sample = feed.samples.at(-1);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2">
      <span>
        {item.title} · {item.label}
        {item.outcome && <> · {item.outcome.toUpperCase()}</>}
      </span>
      <span className="tnum text-xs text-muted-foreground">
        {feed.status === "live" && sample
          ? `YES ${cents(sample.yes)} / NO ${cents(sample.no)} · ${new Date(sample.t).toLocaleTimeString()}`
          : feed.status === "loading"
            ? "Checking quote…"
            : feed.message}
      </span>
      <button
        type="button"
        className="btn btn-chip"
        onClick={onRemove}
        aria-label={`Remove ${item.title} from tracking`}
      >
        Remove
      </button>
    </li>
  );
}

export function MarketDiscoveryPanel() {
  const { market } = useVoice();
  const result = market.result;
  const liquidity = result?.liquidity;
  const tracked = market.tracked ?? [];
  const selected = result?.contract;
  const eventTicker = result?.event_ticker;
  const title = result?.title;
  const canTrack =
    selected &&
    eventTicker &&
    title &&
    tracked.length < 6 &&
    !tracked.some((i) => i.symbol === selected.symbol);
  return (
    <>
      {liquidity && (
        <section aria-label="Displayed liquidity" className="grid gap-1 text-sm">
          <strong>Gemini Sandbox snapshot · {liquidity.side} {liquidity.outcome.toUpperCase()}</strong>
          <p>{liquidity.displayed_quantity ?? "Unknown"} contracts displayed
            {liquidity.limit_price !== null && ` at ${cents(liquidity.limit_price)} or better`}.
            {" "}Spread {liquidity.spread === null ? "unknown" : cents(liquidity.spread)}.</p>
          {liquidity.quantity !== null && <p>{liquidity.depth_unknown ? "Fill estimate unavailable" :
            `Estimated fill: ${liquidity.estimated_executable_quantity} of ${liquidity.quantity} contracts`}
            {liquidity.estimated_average_price !== null && ` at ${cents(liquidity.estimated_average_price)} on average before fees`}.</p>}
          {result?.as_of && <time dateTime={result.as_of}>Observed {new Date(result.as_of).toLocaleTimeString()}</time>}
        </section>
      )}
      {result?.timing?.map((window) => {
        const next = window.next_window;
        if (!next || window.current) return null;
        return (
          <p className="text-sm text-muted-foreground" key={next.contract_symbol}>
            Next window · {next.title} · {next.market_state === "open" ? "Open" : "Post-only"}
          </p>
        );
      })}
      {canTrack && (
        <button
          type="button"
          className="btn btn-chip justify-self-start"
          onClick={() =>
            market.track({ eventTicker, title, symbol: selected.symbol, label: selected.label })
          }
        >
          Track this contract
        </button>
      )}
      {tracked.length > 0 && (
        <section aria-label="Tracked contracts" className="grid gap-1 text-sm">
          <h2 className="font-semibold">Tracked contracts</h2>
          <ul>
            {tracked.map((item) => (
              <TrackedRow
                key={item.symbol}
                item={item}
                onRemove={() => market.untrack(item.symbol)}
              />
            ))}
          </ul>
        </section>
      )}
      {result?.combos && (
        <section aria-label="Gemini Sandbox combos" className="grid gap-2 text-sm">
          <h2 className="font-semibold">Gemini Sandbox combos</h2>
          {!result.combos.length && (
            <p className="text-muted-foreground">
              No matches in {result.listings_checked ?? 0} listings checked.
            </p>
          )}
          {result.combos.map((combo) => (
            <details key={combo.symbol} className="border-b border-border py-2">
              <summary>
                {combo.title} · {combo.legs.length} legs
              </summary>
              <ul className="mt-2 space-y-2 text-muted-foreground">
                {combo.legs.map((leg, i) => (
                  <li key={i}>
                    {leg.title && <>{leg.title} · </>}
                    {leg.label} · {leg.outcome}
                    {leg.resolution && <> · {leg.resolution}</>}
                  </li>
                ))}
              </ul>
              {combo.can_request_quote ? (
                <button
                  type="button"
                  className="btn btn-chip mt-2"
                  onClick={() =>
                    void market.run("get_orderbook", {
                      event_ticker: combo.event_ticker,
                      contract_symbol: combo.symbol,
                    })
                  }
                >
                  Quote combo
                </button>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Unavailable for trading</p>
              )}
            </details>
          ))}
        </section>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { hms } from "../../lib/format";
import { IndexChart } from "./IndexChart";
import { indexUsd as usd, useSettlementIndex } from "./useSettlementIndex";

// The agencies whose index Gemini itself describes as a one-minute average price.
const AGENCIES: Record<string, string> = { lukka: "Lukka", kaiko: "Kaiko" };

/** "4:07" until the given instant, ticking each second; null once it has passed. */
function useCountdown(until: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (until === null || until <= now) return null;
  const s = Math.ceil((until - now) / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/**
 * The index the selected event settles against, loaded when a contract is selected. It is the
 * underlying reference value in USD and is kept apart from the contract's YES/NO prices.
 */
export function SettlementIndexPanel({ eventTicker }: { eventTicker: string }) {
  const feed = useSettlementIndex(eventTicker);
  const { info, points, status } = feed;
  const index = info?.index ?? null;
  const agency = index ? AGENCIES[index.agency.toLowerCase()] : undefined;
  const latest = points.at(-1);
  const closed = status === "closed";
  const start = info?.start ?? null;
  const expiresIn = useCountdown(closed ? null : (info?.expiry ?? null));
  const upcoming = start !== null && start > Date.now();
  const shownValue = closed ? (info?.settlement ?? null) : (latest?.value ?? null);
  const link = info?.deepLink && (
    <a
      href={info.deepLink}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2"
    >
      Open the original chart on Gemini
    </a>
  );
  return (
    <section
      aria-label="Settlement index chart"
      className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {index ? index.code : "Settlement index"}
          {index && (
            <span className="ml-2 font-normal text-muted-foreground">
              {agency
                ? `${agency} one-minute settlement index`
                : `${index.agency} settlement index`}{" "}
              · USD
            </span>
          )}
        </h3>
        <span role="status" className="text-xs text-muted-foreground">
          {status === "loading"
            ? "Loading index…"
            : status === "live"
              ? "Live · Gemini Sandbox"
              : status === "waiting"
                ? upcoming
                  ? `Window opens at ${hms(new Date(start).toISOString())}`
                  : "Waiting for the first index tick…"
                : closed
                  ? "Event closed"
                  : status === "unavailable"
                    ? "Unavailable"
                    : feed.message}
        </span>
      </div>
      {index && (
        <dl className="mb-3 grid grid-cols-3 gap-2 sm:gap-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Price to beat</dt>
            <dd className="tnum text-lg font-semibold tracking-tight">{usd(info?.priceToBeat)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {closed ? "Settlement value" : "Current index"}
            </dt>
            <dd className="tnum text-lg font-semibold tracking-tight">{usd(shownValue)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{closed ? "Expired" : "Expires in"}</dt>
            <dd className="tnum text-lg font-semibold tracking-tight">
              {closed
                ? info?.expiry
                  ? hms(new Date(info.expiry).toISOString())
                  : "—"
                : (expiresIn ?? "—")}
            </dd>
          </div>
        </dl>
      )}
      {index && points.length > 0 ? (
        <IndexChart
          points={points}
          priceToBeat={info?.priceToBeat ?? null}
          start={info?.start ?? null}
          expiry={info?.expiry ?? null}
          label={`${index.code} settlement index`}
        />
      ) : (
        status !== "loading" &&
        status !== "waiting" && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {status === "unavailable"
              ? feed.message
              : closed
                ? "Gemini Sandbox returned no index history for this event window."
                : "No index value received yet."}
          </p>
        )
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {index
          ? "Index values as published by Gemini Sandbox. This is not the contract's YES/NO price or a spot market price. "
          : ""}
        {link}
      </p>
    </section>
  );
}

import { useEffect, useState } from "react";
import type { MarketContract } from "../console/types";

// One observation of the Gemini Sandbox buy prices for a single contract, taken while the
// panel is open. `t` is the quote route's `as_of` (when our server read Gemini), in ms.
// `gap` marks a sample that follows missed polls, so the chart never draws across them.
export type QuoteSample = { t: number; yes: number | null; no: number | null; gap: boolean };
export type QuoteTarget = { eventTicker: string; symbol: string };
export type QuoteFeed = {
  samples: QuoteSample[];
  title: string | null;
  contract: MarketContract | null;
  // loading: no answer yet · live: last poll succeeded · stale: last poll failed ·
  // closed: Gemini no longer lists the contract as open, polling has stopped.
  status: "loading" | "live" | "stale" | "closed";
  message: string;
};

export const POLL_MS = 5000;
export const MAX_SAMPLES = 720;
const REQUEST_TIMEOUT_MS = 8000;
const empty: QuoteFeed = {
  samples: [],
  title: null,
  contract: null,
  status: "loading",
  message: "",
};

const price = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

/** Polls the existing read-only quote route for exactly one event/contract pair. */
export function useContractQuotes(target: QuoteTarget | null, intervalMs = POLL_MS): QuoteFeed {
  const [feed, setFeed] = useState<QuoteFeed>(empty);
  const eventTicker = target?.eventTicker;
  const symbol = target?.symbol;
  useEffect(() => {
    setFeed(empty);
    if (!eventTicker || !symbol) return;
    // `live` guards every state write: a response for a previous contract, or one that
    // lands after unmount, is dropped instead of being plotted on the wrong chart.
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let lastT = -Infinity;
    const url =
      "/api/public/market-tools/get_orderbook?" +
      new URLSearchParams({ event_ticker: eventTicker, contract_symbol: symbol });
    const stale = (message: string) =>
      setFeed((f) => ({ ...f, status: f.status === "closed" ? "closed" : "stale", message }));
    const stop = (message: string, contract?: MarketContract) =>
      setFeed((f) => ({ ...f, status: "closed", message, ...(contract && { contract }) }));

    const poll = async () => {
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
      let again = true;
      try {
        const response = await fetch(url, { cache: "no-store", signal: request.signal });
        const body = await response.json().catch(() => null);
        if (!live) return;
        const contract = body?.contract as MarketContract | undefined;
        const t = Date.parse(body?.as_of);
        if (response.status === 404) {
          again = false;
          stop("Gemini Sandbox no longer lists this contract.");
        } else if (!response.ok || body?.ok !== true) {
          stale("Gemini Sandbox quote unavailable. Retrying.");
        } else if (body.event_ticker !== eventTicker || contract?.symbol !== symbol) {
          stale("Quote response did not match this contract. Retrying.");
        } else if (!Number.isFinite(t) || t <= lastT) {
          // Missing, unparseable or out-of-order timestamp: never plot it.
          stale("Quote had no usable timestamp. Retrying.");
        } else if (
          contract.status !== "active" ||
          contract.market_state !== "open" ||
          (contract.expiry !== null && !(Date.parse(contract.expiry) > t))
        ) {
          again = false;
          stop("Contract is closed on Gemini Sandbox. Sampling stopped.", contract);
        } else {
          const gap = lastT !== -Infinity && t - lastT > intervalMs * 3;
          lastT = t;
          const sample = { t, yes: price(contract.buy?.yes), no: price(contract.buy?.no), gap };
          setFeed((f) => ({
            samples: [...f.samples, sample].slice(-MAX_SAMPLES),
            title: typeof body.title === "string" ? body.title : null,
            contract,
            status: "live",
            message: "",
          }));
        }
      } catch {
        if (live) stale("Gemini Sandbox quote unavailable. Retrying.");
      } finally {
        clearTimeout(timeout);
      }
      if (live && again) timer = setTimeout(() => void poll(), intervalMs);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
      request?.abort();
    };
  }, [eventTicker, symbol, intervalMs]);
  return feed;
}

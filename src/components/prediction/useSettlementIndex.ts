import { useEffect, useState } from "react";

// The index a prediction event settles against, exactly as Gemini publishes it:
// - `info` (index name, window, price to beat, settlement, history) from our read-only route,
//   which only relays Gemini Sandbox public data;
// - live ticks from Gemini's public sandbox stream, the same subscription Gemini's own chart uses.
// A point is only ever a value Gemini sent. Nothing is interpolated or taken from spot prices.
export type IndexPoint = { t: number; value: number };
export type IndexInfo = {
  eventTicker: string;
  deepLink: string | null;
  index: { agency: string; code: string; stream: string } | null;
  start: number | null;
  expiry: number | null;
  priceToBeat: number | null;
  settlement: number | null;
};
export type IndexFeed = {
  info: IndexInfo | null;
  points: IndexPoint[];
  // loading: no answer yet · live: receiving ticks · waiting: stream open, no tick yet ·
  // stale: stream dropped, reconnecting · closed: event window over · unavailable: no index source.
  status: "loading" | "live" | "waiting" | "stale" | "closed" | "unavailable";
  message: string;
};

/** USD with enough decimals for low-priced indices (XRP, SOL) to show their real movement. */
export function indexUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 10 ? 3 : 5;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

export const INDEX_STREAM_URL = "wss://ws.sandbox.gemini.com";
export const MAX_POINTS = 3600;
const RETRY_MS = 5000;
const SETTLE_DELAY_MS = 8000;
const SETTLE_ATTEMPTS = 4;
const OPEN_DELAY_MS = 3000;
const empty: IndexFeed = { info: null, points: [], status: "loading", message: "" };

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const instant = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const merge = (points: IndexPoint[], extra: IndexPoint[]) => {
  const byTime = new Map(points.map((p) => [p.t, p.value]));
  for (const p of extra) byTime.set(p.t, p.value);
  return [...byTime]
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({ t, value }))
    .slice(-MAX_POINTS);
};

function parseInfo(
  body: unknown,
  eventTicker: string,
): { info: IndexInfo; history: IndexPoint[] } | null {
  const b = body as Record<string, unknown> | null;
  if (b?.["ok"] !== true || b["event_ticker"] !== eventTicker) return null;
  const idx = b["index"] as Record<string, unknown> | null;
  const index =
    idx && [idx["agency"], idx["code"], idx["stream"]].every((v) => typeof v === "string" && v)
      ? {
          agency: idx["agency"] as string,
          code: idx["code"] as string,
          stream: idx["stream"] as string,
        }
      : null;
  const link = b["deep_link"];
  const history = (Array.isArray(b["history"]) ? b["history"] : []).flatMap((p: unknown) => {
    const point = p as Partial<IndexPoint> | null;
    const t = positive(point?.t);
    const value = positive(point?.value);
    return t !== null && value !== null ? [{ t, value }] : [];
  });
  // Gemini publishes the settlement as the index value at expiry, so it is the window's last point.
  const expiry = instant(b["expires_at"]);
  const settlement = positive(b["settlement_value"]);
  if (expiry !== null && settlement !== null) history.push({ t: expiry, value: settlement });
  return {
    info: {
      eventTicker,
      deepLink:
        typeof link === "string" && link.startsWith("https://exchange.sandbox.gemini.com/")
          ? link
          : null,
      index,
      start: instant(b["starts_at"]),
      expiry,
      priceToBeat: positive(b["price_to_beat"]),
      settlement,
    },
    history,
  };
}

/** Loads one event's settlement index on demand and follows Gemini's live index stream until expiry. */
export function useSettlementIndex(eventTicker: string | null | undefined): IndexFeed {
  const [feed, setFeed] = useState<IndexFeed>(empty);
  useEffect(() => {
    setFeed(empty);
    if (!eventTicker) return;
    // `live` guards every write so a response or tick for a previous event is never plotted here.
    let live = true;
    let socket: WebSocket | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (live) fn();
      }, ms);
      timers.add(timer);
    };
    const url =
      "/api/public/market-tools/get_settlement_index?" +
      new URLSearchParams({ event_ticker: eventTicker });
    const load = async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        });
        return parseInfo(await response.json().catch(() => null), eventTicker);
      } catch {
        return null;
      }
    };
    const closeSocket = () => {
      const s = socket;
      socket = undefined;
      if (s) {
        s.onclose = s.onerror = s.onmessage = s.onopen = null;
        s.close();
      }
    };

    // After expiry Gemini publishes the settlement value a few seconds later; read it, then stop.
    const settle = (attempt: number) => {
      closeSocket();
      setFeed((f) => ({ ...f, status: "closed", message: "" }));
      void load().then((loaded) => {
        if (!live) return;
        if (loaded)
          setFeed((f) => ({ ...f, info: loaded.info, points: merge(f.points, loaded.history) }));
        if (!loaded?.info.settlement && attempt < SETTLE_ATTEMPTS)
          later(() => settle(attempt + 1), SETTLE_DELAY_MS);
      });
    };

    const follow = (info: IndexInfo & { index: NonNullable<IndexInfo["index"]> }) => {
      if (!live || typeof WebSocket === "undefined") return;
      const { start, expiry } = info;
      const retry = () => {
        closeSocket();
        if (!live) return;
        setFeed((f) => ({
          ...f,
          status: "stale",
          message: "Gemini index stream interrupted. Reconnecting.",
        }));
        later(() => follow(info), RETRY_MS);
      };
      const ws = new WebSocket(INDEX_STREAM_URL);
      socket = ws;
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id: `sub-${Date.now()}`,
            method: "SUBSCRIBE",
            params: [info.index.stream],
          }),
        );
      ws.onerror = retry;
      ws.onclose = retry;
      ws.onmessage = (message) => {
        if (!live || socket !== ws) return;
        let tick: { status?: unknown; p?: unknown; E?: unknown };
        try {
          tick = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (typeof tick.status === "number") {
          if (tick.status < 400) return;
          closeSocket();
          setFeed((f) => ({
            ...f,
            status: "unavailable",
            message: "Gemini Sandbox does not stream this index.",
          }));
          return;
        }
        // Index ticks carry the value as a string and the observation time in whole seconds.
        const value = typeof tick.p === "string" ? positive(Number(tick.p)) : null;
        const seconds = positive(tick.E);
        if (value === null || seconds === null) return;
        const t = seconds * 1000;
        if (start !== null && t < start) return;
        if (expiry !== null && t > expiry) return;
        setFeed((f) => ({
          ...f,
          status: "live",
          message: "",
          points: merge(f.points, [{ t, value }]),
        }));
      };
    };

    void load().then((loaded) => {
      if (!live) return;
      if (!loaded) {
        setFeed({
          ...empty,
          status: "unavailable",
          message: "Gemini Sandbox event details unavailable.",
        });
        return;
      }
      const { info, history } = loaded;
      const over = info.expiry !== null && info.expiry <= Date.now();
      if (!info.index) {
        setFeed({
          info,
          points: [],
          status: "unavailable",
          message: "Gemini does not publish a settlement index for this event.",
        });
        return;
      }
      setFeed({
        info,
        points: merge([], history),
        status: over ? "closed" : "waiting",
        message: "",
      });
      if (over) {
        if (!info.settlement) later(() => settle(1), SETTLE_DELAY_MS);
        return;
      }
      follow({ ...info, index: info.index });
      // Gemini publishes the price to beat when the window opens; re-read the event once it has.
      const opens = info.start === null ? null : info.start - Date.now() + OPEN_DELAY_MS;
      if (info.priceToBeat === null && opens !== null && opens > 0 && opens < 2 ** 31)
        later(() => {
          void load().then((reloaded) => {
            if (live && reloaded) setFeed((f) => ({ ...f, info: reloaded.info }));
          });
        }, opens);
      // Timers cannot wait longer than ~24 days; a later expiry is picked up on the next selection.
      const wait = info.expiry === null ? null : info.expiry - Date.now() + SETTLE_DELAY_MS;
      if (wait !== null && wait < 2 ** 31) later(() => settle(0), wait);
    });
    return () => {
      live = false;
      for (const timer of timers) clearTimeout(timer);
      closeSocket();
    };
  }, [eventTicker]);
  return feed;
}

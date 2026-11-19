import { geminiReadError, gPublic } from "./gemini";

// The index a prediction event settles against, as Gemini itself publishes it. Nothing here is
// derived from spot trades or contract quotes:
// - event metadata (index name, window, price to beat, settlement) comes from the public event read;
// - history comes from Gemini's public index klines, the request Gemini's own web chart makes.
//   A bar's close is the index value at the end of that minute (it equals the published strike and
//   settlement values of adjacent five-minute events), so each bar is plotted at its end.
// Live ticks are read by the browser from Gemini's public sandbox stream named in `index.stream`.

const WEB_ORIGIN = "https://exchange.sandbox.gemini.com";
const MAX_HISTORY_MS = 6 * 60 * 60 * 1000;
const MINUTE = 60_000;

export type IndexPoint = { t: number; value: number };

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const positive = (value: unknown) => {
  const n = typeof value === "number" ? value : text(value) === null ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const instant = (value: unknown) => {
  const ms = Date.parse(text(value) ?? "");
  return Number.isFinite(ms) ? ms : null;
};
const isoOrNull = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The event's own page on Gemini Sandbox, where the original chart lives. */
export function eventDeepLink(ticker: string, slug: unknown) {
  const safeSlug = text(slug);
  return (
    `${WEB_ORIGIN}/predictions/${encodeURIComponent(ticker)}` +
    (safeSlug && /^[a-z0-9-]{1,200}$/.test(safeSlug) ? `/${safeSlug}` : "")
  );
}

export function klinePoints(rows: unknown, from: number, to: number): IndexPoint[] | null {
  if (!Array.isArray(rows)) return null;
  const points = new Map<number, number>();
  for (const row of rows) {
    if (!Array.isArray(row)) return null;
    const open = row[0];
    const close = positive(row[4]);
    if (typeof open !== "number" || !Number.isFinite(open) || close === null) return null;
    const t = open + MINUTE;
    if (t >= from && t <= to) points.set(t, close);
  }
  return [...points].sort((a, b) => a[0] - b[0]).map(([t, value]) => ({ t, value }));
}

export async function settlementIndex(ticker: string): Promise<Response> {
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  if (!/^[a-z0-9_.-]+$/i.test(ticker) || /^\.+$/.test(ticker))
    return fail("Invalid prediction event identifier.", 400);
  const result = await gPublic("/v1/prediction-markets/events/" + encodeURIComponent(ticker));
  if (!result.ok)
    return fail(
      "Gemini Sandbox event unavailable: " + geminiReadError(result),
      result.status === 404 ? 404 : 502,
    );
  const body = result.data?.data ?? result.data;
  const event = (Array.isArray(body) ? body : [body]).find((e) => e?.ticker === ticker);
  if (!event) return fail("Prediction event unavailable.", 404);

  const now = Date.now();
  const contracts = Array.isArray(event.contracts) ? event.contracts : [];
  const agency = text(event.sourceDetails?.agency);
  const code = text(event.sourceDetails?.index);
  const named = agency && code && [agency, code].every((v) => /^[a-z0-9_-]{1,40}$/i.test(v));
  const start = instant(event.startTime) ?? instant(contracts[0]?.effectiveDate);
  const expiry = instant(event.expiryDate);
  // Only a single up/down contract has one price to beat; ladders of strikes do not.
  const strike = contracts.length === 1 ? contracts[0]?.strike : null;

  let history: IndexPoint[] = [];
  let historyAvailable = false;
  if (named && start !== null && start < now) {
    const to = Math.min(now, expiry ?? now);
    const from = Math.max(start, to - MAX_HISTORY_MS);
    const klines = await gPublic("/v2/klines", {
      agency,
      index: code,
      interval: "1m",
      startTime: from - MINUTE,
      endTime: to,
    });
    const points = klines.ok ? klinePoints(klines.data, from, to) : null;
    if (points) {
      history = points;
      historyAvailable = true;
    }
  }

  return Response.json({
    ok: true,
    source: "Gemini Sandbox",
    as_of: new Date(now).toISOString(),
    event_ticker: ticker,
    title: text(event.title),
    status: text(event.status),
    deep_link: eventDeepLink(ticker, event.slug),
    index: named ? { agency, code, stream: `${agency}:${code}@indexPrice` } : null,
    starts_at: isoOrNull(start),
    expires_at: isoOrNull(expiry),
    price_to_beat: positive(strike?.value),
    settlement_value: positive(event.settlement?.value),
    history,
    history_available: historyAvailable,
  });
}

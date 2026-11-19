// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Gemini Prediction Markets client — SANDBOX ONLY.
// Auth: base64(JSON{request, nonce, ...fields}) in X-GEMINI-PAYLOAD,
// hex HMAC-SHA384 of that base64 string in X-GEMINI-SIGNATURE, key in X-GEMINI-APIKEY.
import { env } from "./util";

const SANDBOX_ORIGIN = "https://api.sandbox.gemini.com";
function sandboxUrl(path: string, query: Record<string, string | number | undefined>) {
  const base = env("GEMINI_API_BASE_URL") ?? SANDBOX_ORIGIN;
  if (![SANDBOX_ORIGIN, `${SANDBOX_ORIGIN}/`].includes(base) ||
      (env("GEMINI_HOST") ?? SANDBOX_ORIGIN) !== SANDBOX_ORIGIN) return null;
  const url = new URL(path, SANDBOX_ORIGIN);
  if (url.origin !== SANDBOX_ORIGIN) return null;
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  return url;
}

const invalidOrigin = (): GeminiResult => ({
  ok: false, status: 0, data: null, text: "", error: "Gemini base URL must be the Sandbox origin.",
});

const TIMEOUT_MS = 8000;

export type GeminiResult = {
  missedDeadline?: boolean;
  ok: boolean;
  status: number; // 0 = network error / timeout (outcome unknown)
  data: any; // deno-lint-ignore no-explicit-any
  text: string;
  timedOut?: boolean;
  error?: string;
};

export function hasCredentials(): boolean {
  return Boolean(env("GEMINI_API_KEY") && env("GEMINI_API_SECRET"));
}

// Large int64 ids (orderId > 2^53) must never pass through a JS number.
function parseSafe(text: string): unknown {
  const quoted = text.replace(
    /"(orderId|instrumentId|accountId|globalOrderId)"\s*:\s*(-?\d+)/g,
    '"$1":"$2"',
  );
  try {
    return JSON.parse(quoted);
  } catch {
    return text;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-384" },
      false,
      ["sign"],
  );
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type FetchFailureCategory = "timeout" | "client_config" | "dns" | "tls" | "network" | "unknown";

/** Classify a fetch exception without touching headers, payloads or signatures. */
export function classifyFetchError(e: unknown, timedOut: boolean): FetchFailureCategory {
  if (timedOut) return "timeout";
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const text = `${err?.name ?? ""} ${err?.message ?? ""} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`;
  if (/invalid redirect|redirect value|invalid (url|header|method)|not implemented/i.test(text)) return "client_config";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns|resolve/i.test(text)) return "dns";
  if (/tls|ssl|certificate|CERT_|handshake/i.test(text)) return "tls";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|connection|socket|fetch failed|internal error/i.test(text)) return "network";
  return "unknown";
}

// Error text can echo a URL; keep it short and strip long base64/hex runs (payload- or signature-like).
const scrub = (s: unknown) => String(s ?? "").replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 200);

async function doFetch(url: URL, init: RequestInit): Promise<GeminiResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Cloudflare Workers reject redirect: "error" with a TypeError before any request is sent.
    // "manual" is supported there; redirects are still refused below, never followed.
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      console.error(JSON.stringify({ event: "gemini_redirect_refused", method: init.method, path: url.pathname, status: res.status }));
      return { ok: false, status: res.status, data: null, text: "", error: "Gemini returned a redirect; refusing to follow it." };
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: parseSafe(text), text };
  } catch (e) {
    const timedOut = ctrl.signal.aborted;
    const category = classifyFetchError(e, timedOut);
    // Safe diagnostics only: method, path (no query, headers, payload or signature), error type and cause.
    const err = e as { name?: string; message?: string; cause?: { name?: string; code?: string; message?: string } };
    console.error(JSON.stringify({
      event: "gemini_fetch_failed", category, method: init.method, path: url.pathname,
      error_name: err?.name ?? null, error_message: scrub(err?.message),
      cause_name: err?.cause?.name ?? null, cause_code: err?.cause?.code ?? null, cause_message: scrub(err?.cause?.message),
    }));
    return {
      ok: false, status: 0, data: null, text: "", timedOut,
      error: timedOut ? "Gemini request timed out." : `Gemini request failed before an HTTP response (${category}).`,
    };
  } finally {
    clearTimeout(t);
  }
}

/** Public, unauthenticated GET. */
export function gPublic(path: string, query: Record<string, string | number | undefined> = {}) {
  const url = sandboxUrl(path, query);
  return url ? doFetch(url, { method: "GET", headers: { Accept: "application/json" } }) : Promise.resolve(invalidOrigin());
}

let signedQueue = Promise.resolve();
let lastSignedSecond = 0;

async function signedOnce(
  method: "GET" | "POST",
  path: string,
  fields: Record<string, unknown>,
  query: Record<string, string | number | undefined>,
  nonceCollision = false,
  submitBefore?: number,
): Promise<GeminiResult> {
  const url = sandboxUrl(path, query);
  if (!url) return invalidOrigin();
  const apiKey = env("GEMINI_API_KEY");
  const secret = env("GEMINI_API_SECRET");
  if (!apiKey || !secret) {
    return { ok: false, status: 0, data: null, text: "", error: "GEMINI_API_KEY / GEMINI_API_SECRET not configured" };
  }
  const now = Date.now();
  // On a collision another client may already own this second. Reserve the next
  // second, while staying inside Gemini’s time-based authentication window.
  const advance = nonceCollision ? 1 : 0;
  const delay = (lastSignedSecond + 1 - advance) * 1000 - now;
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  lastSignedSecond = Math.max(lastSignedSecond + 1, Math.floor(Date.now() / 1000) + advance);
  const payloadJson = JSON.stringify({ ...fields, request: path, nonce: lastSignedSecond });
  const payload = b64(payloadJson);
  const sig = toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload)));

  const headers: Record<string, string> = {
    "X-GEMINI-APIKEY": apiKey,
    "X-GEMINI-PAYLOAD": payload,
    "X-GEMINI-SIGNATURE": sig,
    "Cache-Control": "no-cache",
    Accept: "application/json",
    "Content-Type": "text/plain",
    "Content-Length": "0",
  };
  if (submitBefore !== undefined && Date.now() >= submitBefore)
    return { ok: false, status: 0, data: null, text: "", missedDeadline: true };
  return doFetch(url, { method, headers });
}

const safeReasons = new Set(["InvalidNonce", "InvalidSignature", "InvalidApiKey", "InvalidApikey", "MissingRole", "Unauthorized", "Forbidden", "InvalidAccountType", "EndpointNotFound", "RateLimit", "SystemError"]);

export function geminiReadError(result: GeminiResult): string {
  if (result.status === 0) return result.error ?? "Gemini request failed before an HTTP response.";
  const reason = result.data?.reason;
  return `HTTP ${result.status}${safeReasons.has(reason) ? ` ${reason}` : ""}`;
}

function isInvalidNonce(r: GeminiResult): boolean {
  return r.status === 400 && /InvalidNonce/i.test(r.text);
}

/**
 * Signed private request. InvalidNonce means the exchange rejected the request before acting,
 * so ONE retry with a fresh nonce is safe even for order placement. Timeouts are NEVER retried.
 */
export async function gPrivate(
  path: string,
  fields: Record<string, unknown> = {},
  opts: { method?: "GET" | "POST"; submitBefore?: number; query?: Record<string, string | number | undefined> } = {},
): Promise<GeminiResult> {
  const method = opts.method ?? "POST";
  const send = async () => {
    const request = (collision = false) => signedOnce(method, path, fields, opts.query ?? {}, collision, opts.submitBefore);
    const result = await request();
    return isInvalidNonce(result) ? request(/has not increased/i.test(result.data?.message ?? "")) : result;
  };
  const result = signedQueue.then(send);
  signedQueue = result.then(() => {}, () => {});
  return result;
}

// ---------- typed-ish helpers ----------

export type Contract = {
  id?: string; label?: string; abbreviatedName?: string | null; ticker?: string; instrumentSymbol?: string;
  status?: string; marketState?: string | null; expiryDate?: string | null;
  prices?: { buy?: { yes?: string; no?: string }; sell?: { yes?: string; no?: string }; bestBid?: string | null; bestAsk?: string | null; lastTradePrice?: string | null } | null;
  strike?: { value?: string | null; type?: string } | null;
  isCombo?: boolean; quantityMinimum?: string | null; quantityIncrement?: string | null; resolutionSide?: string | null;
};
export type GEvent = {
  id?: string; title?: string; ticker?: string; category?: string; status?: string; expiryDate?: string | null;
  contracts?: Contract[]; subcategory?: { name?: string; path?: string[] } | null;
};

let eventsCache: { at: number; events: GEvent[] } | null = null;

export async function listActiveEvents(): Promise<{ events: GEvent[]; error?: string }> {
  if (eventsCache && Date.now() - eventsCache.at < 15_000) return { events: eventsCache.events };
  const all: GEvent[] = [];
  for (let page = 0; page < 5; page++) {
    const r = await gPublic("/v1/prediction-markets/events", { status: "active", limit: 100, offset: page * 100 });
    if (!r.ok) {
      if (all.length) break;
      return { events: [], error: `events HTTP ${r.status} ${r.error ?? r.text.slice(0, 200)}` };
    }
    const data: GEvent[] = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
    all.push(...data);
    if (data.length < 100) break;
  }
  eventsCache = { at: Date.now(), events: all };
  return { events: all };
}

/** Fresh read of one event (used for re-quotes; never cached). */
export async function getEvent(ticker: string): Promise<{ event: GEvent | null; error?: string; raw?: unknown }> {
  const r = await gPublic(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
  if (!r.ok) return { event: null, error: `event HTTP ${r.status} ${r.error ?? r.text.slice(0, 200)}` };
  const ev = (r.data?.data ?? r.data) as GEvent;
  return { event: ev, raw: r.data };
}

export function findContract(ev: GEvent | null, symbol: string): Contract | null {
  return ev?.contracts?.find((c) => c.instrumentSymbol === symbol) ?? null;
}

export function contractTradable(c: Contract): boolean {
  return (c.status ?? "active") === "active" && (c.marketState ?? "open") === "open";
}

/** Price to BUY an outcome (the ask for that outcome) and price to SELL it (the bid). */
export function quoteFor(c: Contract, outcome: "yes" | "no"): { buy: number | null; sell: number | null } {
  const p = c.prices ?? {};
  const n = (v: unknown) => {
    const x = Number(v);
    return v !== null && v !== undefined && v !== "" && Number.isFinite(x) && x > 0 && x < 1 ? x : null;
  };
  return { buy: n(p.buy?.[outcome]), sell: n(p.sell?.[outcome]) };
}

export async function getUsdAvailable(): Promise<{ usd: number | null; raw: unknown; error?: string }> {
  const r = await gPrivate("/v1/balances");
  if (!r.ok) return { usd: null, raw: r.data, error: `Balances: ${geminiReadError(r)}` };
  if (!Array.isArray(r.data)) return { usd: null, raw: r.data, error: "Gemini returned an unexpected balances response." };
  const arr = Array.isArray(r.data) ? r.data : [];
  // deno-lint-ignore no-explicit-any
  const usd = arr.find((b: any) => String(b.currency).toUpperCase() === "USD");
  return { usd: usd ? Number(usd.available ?? usd.amount) : 0, raw: r.data };
}

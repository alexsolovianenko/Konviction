// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Shared helpers: responses, limits, fees, hashing, formatting.

// Port note: Deno.env.get(X) -> process.env[X], read lazily (Workers inject env per request).
export const env = (name: string): string | undefined => process.env[name];

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tool-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function envStr(name: string, fallback = ""): string {
  return env(name) ?? fallback;
}

function envNum(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Port note: getters so env is read at request time, not module load.
export const LIMITS = {
  get maxOrderUsd() { return envNum("MAX_ORDER_USD", 25); },
  get maxDailyUsd() { return envNum("MAX_DAILY_USD", 50); },
  get maxLimitPrice() { return Math.min(0.99, envNum("MAX_LIMIT_PRICE", 0.99)); },
  minLimitPrice: 0.01,
  get maxQuantity() { return envNum("MAX_QUANTITY", 100); },
  get intentTtlSeconds() { return envNum("INTENT_TTL_SECONDS", 90); },
  takerRate: 0.07, // Gemini production taker schedule; sandbox fees unverified -> always labelled an estimate
  toJSON() {
    return {
      maxOrderUsd: this.maxOrderUsd, maxDailyUsd: this.maxDailyUsd, maxLimitPrice: this.maxLimitPrice,
      minLimitPrice: this.minLimitPrice, maxQuantity: this.maxQuantity, intentTtlSeconds: this.intentTtlSeconds,
      takerRate: this.takerRate,
    };
  },
};

export const BUY_CUTOFF_MS = 10_000;

export const displayTz = () => envStr("DISPLAY_TZ", "America/Chicago");

/** Taker fee estimate: rate x contracts x P x (1-P), rounded up to the cent. */
export function feeEstimate(qty: number, price: number): number {
  const raw = LIMITS.takerRate * qty * price * (1 - price);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Parse a decimal string from Gemini. Returns null for missing/blank/non-numeric. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A usable contract price must be strictly between 0 and 1. */
export function price(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 && n < 1 ? n : null;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function maskPhone(p: string | null | undefined): string {
  if (!p) return "unknown";
  if (!/\d{4}/.test(p)) return p; // e.g. "web"
  return "•••" + p.replace(/\D/g, "").slice(-4);
}

export async function hashPhone(p: string): Promise<string> {
  return (await sha256Hex("v2p-caller:" + p)).slice(0, 16);
}

export function speakTime(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: displayTz(), hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: displayTz(), weekday: "long", month: "short", day: "numeric" }).format(d);
  return `${time}, ${day}`;
}

export function localHour(iso: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: displayTz(), hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour: h, minute: m };
}

export function cents(p: number): string {
  return `${Math.round(p * 100)} cents`;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time compare that also hides the expected length (compares SHA-256 digests). */
export async function secretEqual(got: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  return safeEqual(await sha256Hex("v2p-cmp:" + got), await sha256Hex("v2p-cmp:" + expected));
}

/**
 * Header-only auth. The old `?s=` query-string fallback was removed: URLs end up in
 * proxy/access logs and ElevenLabs tool configs, which would leak the secret.
 */
export async function toolAuthorized(req: Request): Promise<boolean> {
  const expected = envStr("TOOL_SHARED_SECRET");
  if (expected.length < 24) return false; // refuse weak or missing secrets
  return secretEqual(req.headers.get("x-tool-secret") ?? "", expected);
}

/** Port note: no after-response hook available in this route runtime, so the work is awaited. */
export async function background(p: Promise<unknown>): Promise<void> {
  const safe = p.catch((e) => console.error("background task failed", e));
  await safe;
}

export function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

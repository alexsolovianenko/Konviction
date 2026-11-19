// @ts-nocheck -- supabase-js rows are untyped here, like the rest of src/server/v2p.
// Browser voice trading on Cloudflare Workers + Supabase (port of alex's server/browser-trading.mjs,
// which used local Node + SQLite).
//
//   GET  availability            public: is approval possible (names missing config, never values)
//   POST session                 mint verified voice session + ElevenLabs signed URL
//   POST proposals   (Bearer)    quote + save a BUY proposal bound to the session. Never submits.
//   POST approve     (Bearer)    typed PIN + exact proposal id -> the ONLY order-submission path
//   POST end         (Bearer)    revoke the session
//   POST portfolio               typed PIN -> sanitized Gemini open orders, positions, order history
//
// The language model can reach `proposals` only through the browser client tool; it never sees the
// session token or the PIN, and no voice tool can call `approve`.
import { db, executionEnabled, logActivity } from "./db";
import { createReceipt } from "./receipts";
import { gPrivate, hasCredentials } from "./gemini";
import { prepareTrade, executeTrade, isValidBuySize } from "./trade-engine";
import { dailyCapError, orderCapError, supabaseLedger } from "./ledger";
import {
  fetchSignedUrl, mintSessionToken, SESSION_PREFIX, SESSION_TTL_MS, sessionConfigured, verifySessionToken,
} from "./browser-session";
import { env, json, randomCode, secretEqual } from "./util";

export class TradeError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
    this.name = "TradeError";
  }
}
const bad = () => { throw new TradeError("BAD_INPUT", "Invalid trade parameters.", 400); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOL = /^[A-Z0-9][A-Z0-9_.-]{0,99}$/i;
const keysAre = (o, keys) => o && typeof o === "object" && !Array.isArray(o) &&
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

export const PIN_LOCK_MS = 15 * 60_000;
export const SESSION_PIN_ATTEMPTS = 3;
export const GLOBAL_PIN_ATTEMPTS = 10;
export const GLOBAL_GUARD = "approval-pin:global";

// ------------------------------------------------------------------ storage (Supabase)

export type Store = ReturnType<typeof supabaseStore>;
export function supabaseStore() {
  const now = () => new Date().toISOString();
  return {
    async createSession(sid: string) {
      const { error } = await db.from("callers").insert({ phone: SESSION_PREFIX + sid, call_count: 1 });
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not start a voice session.", 503);
    },
    /** callers row: {phone, pin_failures, locked_until} or null. Used for sessions and the global PIN guard. */
    async getGuard(key: string) {
      const { data, error } = await db.from("callers").select("phone,pin_failures,locked_until").eq("phone", key).maybeSingle();
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Approval service unavailable.", 503);
      return data;
    },
    async setGuard(key: string, failures: number, lockedUntil: string | null) {
      const { error } = await db.from("callers").upsert({ phone: key, pin_failures: failures, locked_until: lockedUntil, last_seen: now() });
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not update the session guard.", 503);
    },
    async supersede(caller: string) {
      const { error } = await db.from("intents").update({ status: "SUPERSEDED", updated_at: now() }).eq("caller", caller).eq("status", "PROPOSED");
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not replace the previous proposal.", 503);
    },
    async insertIntent(row) {
      const { data, error } = await db.from("intents").insert(row).select("id").single();
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not save the proposal. Nothing was placed.", 503);
      return data.id as string;
    },
    /** Atomic single use: PROPOSED -> EXECUTING once, only for this session and only before expiry. */
    async claim(id: string, caller: string) {
      const { data, error } = await db.from("intents").update({ status: "EXECUTING", updated_at: now() })
        .eq("id", id).eq("caller", caller).eq("status", "PROPOSED").eq("side", "buy").gt("expires_at", now()).select("*");
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Approval service unavailable. Nothing was placed.", 503);
      return data?.length === 1 ? data[0] : null;
    },
    async getIntent(id: string) {
      const { data } = await db.from("intents").select("*").eq("id", id).maybeSingle();
      return data;
    },
    async setIntentStatus(id: string, status: string) {
      const { error } = await db.from("intents").update({ status, updated_at: now() }).eq("id", id);
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not record the proposal status.", 503);
    },
    async getOrderByIntent(intentId: string) {
      const { data } = await db.from("orders").select("*").eq("intent_id", intentId).maybeSingle();
      return data;
    },
    async saveOrder(row) {
      const { error } = await db.from("orders").insert(row);
      if (error) throw new TradeError("RESULT_UNAVAILABLE", "Check Gemini order history before taking further action.", 503);
    },
    committedUsd: supabaseLedger.committedUsd,
    log: (kind: string, caller: string | null, summary: string, detail?: unknown) => logActivity(kind, caller, summary, detail),
    receipt: createReceipt,
  };
}

// ------------------------------------------------------------------ config

function pinConfigured() {
  return /^\d{4,8}$/.test(env("DEMO_PIN") ?? "");
}
export async function availability() {
  const missing: string[] = [];
  if (!hasCredentials()) missing.push("Gemini Sandbox credentials");
  if (!pinConfigured()) missing.push("a 4-8 digit DEMO_PIN");
  if (!sessionConfigured()) missing.push("VOICE_SESSION_SECRET");
  const ledgerConfigured = Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
  if (!ledgerConfigured) missing.push("the private Supabase ledger");
  const enabled = ledgerConfigured && await executionEnabled().catch(() => false);
  if (!enabled) missing.push("execution switched on (EXECUTION_ENABLED and settings)");
  return {
    ok: true,
    execution_enabled: missing.length === 0,
    message: missing.length ? "Approval unavailable. Configure " + missing.join(", ") + "." : "Sandbox approval is enabled.",
  };
}

// ------------------------------------------------------------------ guards

async function requireSession(store: Store, token: string | undefined) {
  const claims = await verifySessionToken(token);
  if (!claims) throw new TradeError("UNAUTHORIZED", "An active verified voice session is required.", 401);
  const row = await store.getGuard(SESSION_PREFIX + claims.sid);
  if (!row) throw new TradeError("UNAUTHORIZED", "An active verified voice session is required.", 401);
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    throw new TradeError("LOCKED", "This voice session is closed or locked. Start a new session.", 423);
  }
  return { ...claims, caller: SESSION_PREFIX + claims.sid };
}

/** Typed-PIN check with a per-session lock (3 misses) and an account-wide lock (10 misses). */
async function requirePin(store: Store, pin: unknown, sessionKey: string | null) {
  if (!pinConfigured()) throw new TradeError("PIN_UNCONFIGURED", "Approval PIN is not configured on the server.", 503);
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) bad();
  const nowMs = Date.now();
  const locked = (r) => r?.locked_until && Date.parse(r.locked_until) > nowMs;
  const global = await store.getGuard(GLOBAL_GUARD);
  if (locked(global)) throw new TradeError("LOCKED", "Too many wrong PINs. Approval is locked for 15 minutes.", 429);
  const session = sessionKey ? await store.getGuard(sessionKey) : null;
  if (locked(session)) throw new TradeError("LOCKED", "Too many wrong PINs for this session. Start a new session later.", 429);

  if (await secretEqual(pin, env("DEMO_PIN") ?? "")) {
    if ((global?.pin_failures ?? 0) > 0) await store.setGuard(GLOBAL_GUARD, 0, null);
    if (sessionKey && (session?.pin_failures ?? 0) > 0) await store.setGuard(sessionKey, 0, null);
    return;
  }
  const until = new Date(nowMs + PIN_LOCK_MS).toISOString();
  const g = (global?.pin_failures ?? 0) + 1;
  await store.setGuard(GLOBAL_GUARD, g >= GLOBAL_PIN_ATTEMPTS ? 0 : g, g >= GLOBAL_PIN_ATTEMPTS ? until : null);
  if (sessionKey) {
    const s = (session?.pin_failures ?? 0) + 1;
    await store.setGuard(sessionKey, s >= SESSION_PIN_ATTEMPTS ? 0 : s, s >= SESSION_PIN_ATTEMPTS ? until : null);
  }
  await store.log("PIN_FAILED", sessionKey, "Wrong approval PIN"); // never the PIN itself
  throw new TradeError("WRONG_PIN", "Incorrect PIN. Nothing was placed.", 403);
}

// ------------------------------------------------------------------ actions

async function startSession(store: Store, fetchImpl?: typeof fetch) {
  if (!sessionConfigured()) throw new TradeError("VOICE_UNCONFIGURED", "Voice sessions are not configured on the server.", 503);
  const signed = await fetchSignedUrl(fetchImpl);
  if ("error" in signed) throw new TradeError("ELEVENLABS_UNAVAILABLE", signed.error, 502);
  const sid = crypto.randomUUID();
  await store.createSession(sid);
  const iat = Date.now();
  const exp = iat + SESSION_TTL_MS;
  const token = await mintSessionToken({ v: 1, sid, cid: signed.conversation_id, iat, exp });
  await store.log("VOICE_SESSION_STARTED", SESSION_PREFIX + sid, "Browser voice session started",
    { conversation_id: signed.conversation_id });
  return {
    ok: true, session_id: sid, session_token: token, signed_url: signed.signed_url,
    session_expires_at: new Date(exp).toISOString(),
  };
}

async function propose(store: Store, token: string | undefined, body) {
  const s = await requireSession(store, token);
  const keys = ["event_ticker", "contract_symbol", "outcome", body && Object.hasOwn(body, "budget_usd") ? "budget_usd" : "quantity", "limit_price"];
  if (
    !keysAre(body, keys) ||
    !keys.slice(0, 2).every((k) => typeof body[k] === "string" && SYMBOL.test(body[k])) ||
    !["yes", "no"].includes(body.outcome) ||
    !isValidBuySize(body) ||
    typeof body.limit_price !== "number" || !Number.isFinite(body.limit_price) ||
    body.limit_price < 0.01 || body.limit_price > 0.99 ||
    Math.abs(Math.round(body.limit_price * 100) - body.limit_price * 100) > 1e-8
  ) bad();

  const response = await prepareTrade(
    { event_ticker: body.event_ticker, instrument_symbol: body.contract_symbol, side: "buy", outcome: body.outcome,
      quantity: body.quantity, budget_usd: body.budget_usd, limit_price: body.limit_price },
    async ({ readback, ...terms }) => {
      const committed = await store.committedUsd();
      if (committed === null) return json({ ok: false, error: "RISK_UNAVAILABLE", message: "Could not verify the daily sandbox limit. Nothing was prepared." });
      const capErr = dailyCapError(committed, terms.notional_usd + terms.est_fee_usd);
      if (capErr) return json({ ok: false, error: "CAP_EXCEEDED", message: capErr });
      await store.supersede(s.caller);
      const code = randomCode();
      const id = await store.insertIntent({ ...terms, code, caller: s.caller, conversation_id: s.cid });
      await store.log("INTENT_PROPOSED", s.caller,
        `BUY ${terms.quantity} ${terms.outcome.toUpperCase()} ${terms.instrument_symbol} @ ≤${terms.limit_price}`,
        { code, proposal_id: id, channel: "browser", notional: terms.notional_usd, fee: terms.est_fee_usd, quote: terms.quote_price });
      return json({ ok: true, proposal: { ...terms, readback, proposal_id: id }, availability: await availability() });
    },
  );
  const { detail, ...safe } = await response.json();
  return safe;
}

async function approve(store: Store, token: string | undefined, body) {
  const s = await requireSession(store, token);
  if (!keysAre(body, ["proposal_id", "pin"]) || typeof body.proposal_id !== "string" || !UUID.test(body.proposal_id)) bad();
  const config = await availability();
  if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
  await requirePin(store, body.pin, s.caller);

  const it = await store.claim(body.proposal_id, s.caller);
  if (!it) {
    const row = await store.getIntent(body.proposal_id);
    if (!row || row.caller !== s.caller) throw new TradeError("UNKNOWN_PROPOSAL", "Proposal unavailable for this voice session.", 404);
    if (row.status === "EXECUTING") throw new TradeError("IN_PROGRESS", "Approval already received. Check open trades before doing anything else.");
    const order = ["DONE", "FAILED"].includes(row.status) ? await store.getOrderByIntent(row.id) : null;
    if (order) {
      // Replay: report the recorded Gemini result; never submit a second order.
      return {
        ok: order.outcome_summary !== "EXCHANGE_REJECTED", replayed: true, outcome_summary: order.outcome_summary,
        order_id: order.gemini_order_id, exchange_status: order.exchange_status, filled_quantity: order.filled_qty,
        remaining_quantity: order.remaining_qty, avg_price: order.avg_price,
        say: "This proposal was already approved. Showing the recorded Gemini result.",
      };
    }
    throw new TradeError("INACTIVE", "This proposal was replaced, rejected or expired. Ask for a fresh quote.");
  }

  // Re-check limits on the stored proposal, then the shared daily ledger (this intent is now EXECUTING
  // and reserved; every concurrent claim that reads after ours sees our reservation).
  const capErr = orderCapError(it);
  if (capErr) { await store.setIntentStatus(it.id, "REJECTED"); throw new TradeError("CAP_EXCEEDED", capErr); }
  const committed = await store.committedUsd({ excludeIntentId: it.id });
  if (committed === null) {
    await store.setIntentStatus(it.id, "REJECTED");
    throw new TradeError("RISK_UNAVAILABLE", "Could not verify the daily sandbox limit. Nothing was placed.", 503);
  }
  const dayErr = dailyCapError(committed, Number(it.notional_usd) + Number(it.est_fee_usd));
  if (dayErr) { await store.setIntentStatus(it.id, "REJECTED"); throw new TradeError("CAP_EXCEEDED", dayErr); }

  await store.log("INTENT_APPROVED", s.caller, `${it.code}: approved with typed PIN in the browser`, { proposal_id: it.id });
  const response = await executeTrade(it, s.caller, {
    finish: (status: string) => store.setIntentStatus(it.id, status),
    log: store.log,
    receipt: store.receipt,
    saveOrder: (order) => store.saveOrder(order),
  });
  const { detail, ...result } = await response.json();
  return result;
}

async function endSession(store: Store, token: string | undefined) {
  const claims = await verifySessionToken(token);
  if (!claims) return { ok: true };
  await store.setGuard(SESSION_PREFIX + claims.sid, 0, new Date(claims.exp).toISOString());
  return { ok: true };
}

const accountFields = {
  orders: ["orderId", "symbol", "side", "outcome", "status", "quantity", "price", "filledQuantity", "remainingQuantity", "avgExecutionPrice", "createdAt", "updatedAt"],
  positions: ["symbol", "outcome", "totalQuantity", "quantityOnHold", "avgPrice", "marketValue"],
};
async function accountSection(path: string, kind: "orders" | "positions") {
  const r = await gPrivate(path);
  const rows = r.data?.[kind];
  if (!r.ok || !Array.isArray(rows)) return { error: "Gemini Sandbox data unavailable.", rows: [] };
  return {
    rows: rows.slice(0, 100).map((row) => Object.fromEntries(
      accountFields[kind].filter((k) => ["string", "number"].includes(typeof row?.[k])).map((k) => [k, row[k]]),
    )),
  };
}
async function portfolio(store: Store, body) {
  if (!keysAre(body, ["pin"])) bad();
  await requirePin(store, body.pin, null);
  if (!hasCredentials()) throw new TradeError("ACCOUNT_UNCONFIGURED", "Gemini Sandbox credentials are not configured.", 503);
  const [orders, positions, history] = await Promise.all([
    accountSection("/v1/prediction-markets/orders/active", "orders"),
    accountSection("/v1/prediction-markets/positions", "positions"),
    accountSection("/v1/prediction-markets/orders/history", "orders"),
  ]);
  return { ok: true, as_of: new Date().toISOString(), source: "Gemini Sandbox", orders, positions, history };
}

// ------------------------------------------------------------------ HTTP

export async function runBrowserTrading(
  { action, method, token, body }: { action: string; method: string; token?: string; body?: unknown },
  store: Store = supabaseStore(),
  fetchImpl?: typeof fetch,
) {
  if (method === "GET" && action === "availability") return availability();
  if (method !== "POST") throw new TradeError("NOT_FOUND", "Not found.", 404);
  switch (action) {
    case "session": return startSession(store, fetchImpl);
    case "proposals": return propose(store, token, body);
    case "approve": return approve(store, token, body);
    case "end": return endSession(store, token);
    case "portfolio": return portfolio(store, body);
    default: throw new TradeError("NOT_FOUND", "Not found.", 404);
  }
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleBrowserTrading(req: Request, action: string): Promise<Response> {
  try {
    let body: unknown = {};
    if (req.method === "POST") {
      // JSON only: blocks cross-site form posts. Auth is a Bearer token kept in memory, never a cookie.
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return reply(415, { ok: false, error: "JSON_REQUIRED", message: "JSON required." });
      const text = await req.text();
      if (text.length > 4096) return reply(413, { ok: false, error: "TOO_LARGE", message: "Request too large." });
      try { body = text ? JSON.parse(text) : {}; } catch { return reply(400, { ok: false, error: "BAD_INPUT", message: "Invalid JSON." }); }
    }
    if (action === "session" && req.method === "POST" && !(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"))) {
      // Quotes use public markets. Only a ledger-backed session receives a trading bearer.
      const signed = await fetchSignedUrl();
      if ("error" in signed) throw new TradeError("ELEVENLABS_UNAVAILABLE", signed.error, 502);
      return reply(200, { ok: true, voice_only: true, signed_url: signed.signed_url });
    }
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    return reply(200, await runBrowserTrading({ action, method: req.method, token, body }));
  } catch (e) {
    if (e instanceof TradeError) return reply(e.status, { ok: false, error: e.code, message: e.message });
    console.error(JSON.stringify({ event: "browser_trading_error", action, error_name: (e as Error)?.name ?? null }));
    return reply(503, {
      ok: false, error: "SERVICE_UNAVAILABLE",
      message: action === "approve" ? "Approval result unknown. Check open trades before trying again." : "Trading service unavailable.",
    });
  }
}

// @ts-nocheck -- supabase-js rows are untyped here, like the rest of src/server/v2p.
// Browser voice trading on Cloudflare Workers + Supabase (port of alex's server/browser-trading.mjs,
// which used local Node + SQLite).
//
//   GET  availability            public: is approval possible (names missing config, never values)
//   POST session                 mint verified voice session + ElevenLabs signed URL
//   POST proposals   (Bearer)    quote + save a BUY proposal bound to the session. Never submits.
//   POST call-confirm            ElevenLabs webhook + session + spoken readback and confirmation
//   POST order-result (Bearer)   poll the caller’s proposal without submitting
//   POST end         (Bearer)    revoke the session
//   POST portfolio               sanitized shared sandbox Gemini open orders, positions, order history
//
// The ElevenLabs system injects the conversation history and call ID into its server webhook.
import { confirmedInCall } from "./call-confirmation";
import { spokenBudgetFill, spokenFill } from "../../spoken-fill";
import { validOrderKeys } from "./browser-order-input";
import { hasSpokenMarketName, spokenProposal } from "../../../server/spoken-proposal.mjs";
import { db, executionEnabled, logActivity } from "./db";
import { settledOpenOrders } from "./reconcile-open";
import { buildSandboxCombo } from "./build-combo";
import { sandboxPortfolio } from "./portfolio";
import { blobStore } from "./blob-ledger";
import { createReceipt } from "./receipts";
import { phoneAccount } from "./phone/accounts";
import { getUsdAvailable, hasCredentials } from "./gemini";
import { prepareTrade, executeTrade, remainderBuy } from "./trade-engine";
import { supabaseLedger } from "./ledger";
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

// ------------------------------------------------------------------ storage (Supabase)

export type Store = ReturnType<typeof supabaseStore>;
export function supabaseStore() {
  const now = () => new Date().toISOString();
  // Proposal codes are opaque, immutable and server-generated. The prefix
  // preserves the selected execution strategy on pre-existing SQL schemas.
  const decode = row => {
    if (!row) return row;
    const budget = /^usd:(\d+):/.exec(row.code ?? "");
    const modeCode = budget ? row.code.slice(budget[0].length) : row.code;
    return {...row, ...(budget && {budget_usd: Number(budget[1]) / 100}), ...(modeCode?.startsWith("market:") && {order_mode: "market"})};
  };
  return {
    async createSession(sid: string) {
      const { error } = await db.from("callers").insert({ phone: SESSION_PREFIX + sid, call_count: 1 });
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not start a voice session.", 503);
    },
    /** callers row: {phone, pin_failures, locked_until} or null. Used for session revocation. */
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
    async dismissProposal(id: string, caller: string) {
      const { error } = await db.from("intents").update({ status: "SUPERSEDED", updated_at: now() })
        .eq("id", id).eq("caller", caller).eq("status", "PROPOSED");
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not dismiss the proposal.", 503);
    },
    async insertIntent(row) {
      const {order_mode, budget_usd, ...stored} = row;
      if (order_mode === "market") stored.code = "market:" + stored.code;
      if (budget_usd != null) stored.code = "usd:" + Math.round(budget_usd * 100) + ":" + stored.code;
      const { data, error } = await db.from("intents").insert(stored).select("id").single();
      if (error?.code === "22P02" && row.side === "sell" && !Number.isInteger(row.quantity))
        throw new TradeError("FRACTIONAL_STORAGE_UNAVAILABLE", "This account ledger needs the fractional quantity migration before it can store that exit.", 503);
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Could not save the proposal. Nothing was placed.", 503);
      return data.id as string;
    },
    /** Atomic single use: PROPOSED -> EXECUTING once, only for this session and only before expiry. */
    async claim(id: string, caller: string) {
      const { data, error } = await db.from("intents").update({ status: "EXECUTING", updated_at: now() })
        .eq("id", id).eq("caller", caller).eq("status", "PROPOSED").in("side", ["buy", "sell"]).gt("expires_at", now()).select("*");
      if (error) throw new TradeError("SERVICE_UNAVAILABLE", "Approval service unavailable. Nothing was placed.", 503);
      return data?.length === 1 ? decode(data[0]) : null;
    },
    async getIntent(id: string) {
      const { data } = await db.from("intents").select("*").eq("id", id).maybeSingle();
      return decode(data);
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
    async reconcileOpen(history?) {
      const { data, error } = await db.from("orders")
        .select("intent_id,gemini_order_id,side,intents!inner(instrument_symbol,quantity,limit_price)").eq("outcome_summary", "OPEN");
      if (error) return;
      const updates = await settledOpenOrders(data.map(row => ({ ...row, ...row.intents })), history);
      for (const { intent_id, ...fields } of updates) {
        await db.from("orders").update({ ...fields, created_at: now() }).eq("intent_id", intent_id).eq("outcome_summary", "OPEN");
      }
    },
    committedUsd: supabaseLedger.committedUsd,
    log: (kind: string, caller: string | null, summary: string, detail?: unknown) => logActivity(kind, caller, summary, detail),
    receipt: createReceipt,
  };
}

// ------------------------------------------------------------------ config

const hasSupabase = () => Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
const hasBlob = () => env("LOCAL_BROWSER_LEDGER") !== "sqlite" && Boolean(env("BLOB_READ_WRITE_TOKEN") || env("BLOB_STORE_ID"));
const defaultStore = () => hasSupabase() || !hasBlob() ? supabaseStore() : blobStore();

export async function availability() {
  const missing: string[] = [];
  if (!hasCredentials()) missing.push("Gemini Sandbox credentials");
  if (!env("ELEVENLABS_CALL_CONFIRM_SECRET")) missing.push("ElevenLabs call confirmation");
  if (!sessionConfigured()) missing.push("VOICE_SESSION_SECRET");
  const ledgerConfigured = hasSupabase() || hasBlob();
  if (!ledgerConfigured) missing.push("private order storage");
  const enabled = hasSupabase() ? await executionEnabled().catch(() => false) : hasBlob() && env("EXECUTION_ENABLED") === "true";
  if (!enabled) missing.push("execution switched on (EXECUTION_ENABLED and settings)");
  return {
    ok: true,
    execution_enabled: missing.length === 0,
    voice_authorized: false, // hosted order confirmation uses the call webhook
    voice_confirmation_supported: missing.length === 0,
    call_confirmation_supported: missing.length === 0,
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
  if (!validOrderKeys(body)) bad();

  const response = await prepareTrade(
    { event_ticker: body.event_ticker, instrument_symbol: body.contract_symbol, side: body.side ?? "buy", close_all: body.close_all, outcome: body.outcome,
      quantity: body.quantity, budget_usd: body.budget_usd, limit_price: body.limit_price, order_mode: body.order_mode },
    async ({ readback, ...terms }) => {
      if (!hasSpokenMarketName(terms)) throw new TradeError("BAD_INPUT", "Market name unavailable.", 409);
      await store.supersede(s.caller);
      const code = randomCode();
      const id = await store.insertIntent({ ...terms, code, caller: s.caller, conversation_id: s.cid });
      await store.log("INTENT_PROPOSED", s.caller,
        `${terms.side.toUpperCase()} ${terms.quantity} ${terms.outcome.toUpperCase()} ${terms.instrument_symbol} @ ≤${terms.limit_price}`,
        { code, proposal_id: id, channel: "browser", notional: terms.notional_usd, fee: terms.est_fee_usd, quote: terms.quote_price });
      return json({ ok: true, proposal: { ...terms, readback, voice_readback: s.cid ? spokenProposal(terms) : undefined, proposal_id: id }, availability: await availability() });
    },
  );
  const { detail, ...safe } = await response.json();
  return safe;
}

function validateProposalId(id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) bad();
}

async function ownedIntent(store: Store, id: string, s) {
  const row = await store.getIntent(id);
  if (!row || row.caller !== s.caller || row.conversation_id !== s.cid)
    throw new TradeError("UNKNOWN_PROPOSAL", "Proposal unavailable for this call.", 404);
  return row;
}

async function recordedResult(store: Store, row) {
  if (row.status === "PROPOSED" && Date.parse(row.expires_at) > Date.now())
    return { ok: true, status: row.status };
  const order = await store.getOrderByIntent(row.id);
  if (order) {
    if (row.order_mode === "market" && order.raw?.result?.order_mode === "market") {
      const result = order.raw.result;
      return { ...result, voice_say: spokenBudgetFill(row, result.outcome_summary, result.filled_quantity, result.avg_price) ?? spokenFill(result.outcome_summary, result.filled_quantity, row.quantity, result.avg_price) ?? result.voice_say };
    }
    const remainder = remainderBuy(row, order.outcome_summary, order.filled_qty, order.exchange_status);
    const say = order.outcome_summary === "EXCHANGE_REJECTED" ? "Gemini rejected the sandbox order." :
      order.outcome_summary === "OPEN" ? (Number(order.filled_qty) > 0 ? `Sandbox filled ${order.filled_qty} of ${row.quantity}. The rest is open.` : "Sandbox limit order open.") :
      order.outcome_summary === "PENDING_UNKNOWN" || order.filled_qty == null ? "Gemini hasn't confirmed the final fill." :
      `Filled ${order.filled_qty} of ${row.quantity} sandbox contracts${order.avg_price == null ? "" : " at an average of " + Math.round(Number(order.avg_price) * 100) + "¢"}.`;
    return {
      ok: order.outcome_summary !== "EXCHANGE_REJECTED", outcome_summary: order.outcome_summary,
      order_id: order.gemini_order_id, exchange_status: order.exchange_status, filled_quantity: order.filled_qty,
      remaining_quantity: order.remaining_qty, avg_price: order.avg_price,
      ...(remainder && { remainder_buy: remainder }),
      voice_say: spokenBudgetFill(row, order.outcome_summary, order.filled_qty, order.avg_price) ?? spokenFill(order.outcome_summary, order.filled_qty, row.quantity, order.avg_price) ?? say,
      say: say + (remainder ? ` Ask to retry the remaining ${remainder.quantity} at the original limit.` : ""),
    };
  }
  if (row.status === "EXECUTING")
    return { ok: true, status: row.status };
  const [error, say] = row.status === "PROPOSED" || row.status === "EXPIRED"
    ? ["EXPIRED", "Quote expired. Requote?"]
    : row.status === "SUPERSEDED"
      ? ["SUPERSEDED", "A newer order replaced this one."]
      : ["INACTIVE", row.status === "REJECTED" ? "The sandbox order was rejected." : "Check this order in Account."];
  return { ok: false, error, status: row.status, message: say, say };
}

// The provider includes completed tool calls in history when the agent retries
// without another caller turn. That turn already received its decision.
function alreadyAnsweredTurn(history: unknown) {
  if (typeof history !== "string") return false;
  try {
    const { entries } = JSON.parse(history);
    if (!Array.isArray(entries)) return false;
    for (const entry of [...entries].reverse()) {
      if (entry.role === "user" && /[\p{L}\p{N}]/u.test(entry.message ?? "")) return false;
      if ((entry.role === "tool" || entry.role === "agent") && Array.isArray(entry.tool_results) &&
          entry.tool_results.some(result => result.tool_name === (phoneAccount.getStore() ? "phone_confirm_trade" : "confirm_hosted_sandbox_buy"))) return true;
    }
  } catch { /* Invalid evidence is rejected by the confirmation check. */ }
  return false;
}

async function callConfirm(store: Store, token: string | undefined, body) {
  const s = await requireSession(store, token);
  if (!keysAre(body, ["proposal_id", "conversation_id", "is_text_only", "history"])) bad();
  validateProposalId(body.proposal_id);
  if (!s.cid || s.cid !== body.conversation_id || body.is_text_only !== false)
    throw new TradeError("CALL_REQUIRED", "Confirm in the active voice call.", 403);
  const row = await ownedIntent(store, body.proposal_id, s);
  if (alreadyAnsweredTurn(body.history)) return { ok: true, say: "", next_action: "wait_for_user" };
  if (row.status !== "PROPOSED") return { ...await recordedResult(store, row), replayed: true };
  if (!confirmedInCall(body.history, { toolNames: phoneAccount.getStore() ? ["phone_prepare_trade"] : ["prepare_sandbox_buy", "prepare_sandbox_remainder"],
    idField: "proposal_id", id: row.id, readback: spokenProposal(row), side: row.side, orderMode: row.order_mode }))
    throw new TradeError("CONFIRMATION_REQUIRED", "Confirmation missed. Order not sent.");
  const config = await availability();
  if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
  const it = await store.claim(row.id, s.caller);
  if (!it) return { ...await recordedResult(store, await ownedIntent(store, row.id, s)), replayed: true };

  await store.log("INTENT_APPROVED", s.caller, `${it.code}: confirmed in the voice call`, { proposal_id: it.id });
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

async function portfolio(store: Store, body) {
  if (!keysAre(body, [])) bad();
  if (!hasCredentials()) throw new TradeError("ACCOUNT_UNCONFIGURED", "Gemini Sandbox credentials are not configured.", 503);
  const [account, balance] = await Promise.all([sandboxPortfolio(), getUsdAvailable()]);
  if (!account.history.error && (hasSupabase() || hasBlob())) await store.reconcileOpen?.(account.history.rows);
  return { ...account, usd_available: balance.usd, balance_error: balance.error };
}

// ------------------------------------------------------------------ HTTP

export async function runBrowserTrading(
  { action, method, token, body, callSecret }: { action: string; method: string; token?: string; body?: unknown; callSecret?: string },
  store: Store | ReturnType<typeof blobStore> = defaultStore(),
  fetchImpl?: typeof fetch,
) {
  if (method === "GET" && action === "availability") return availability();
  if (method !== "POST") throw new TradeError("NOT_FOUND", "Not found.", 404);
  switch (action) {
    case "session": return startSession(store, fetchImpl);
    case "build-combo": {
      await requireSession(store, token);
      const config = await availability();
      if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
      return buildSandboxCombo(body);
    }
    case "proposals": return propose(store, token, body);
    case "call-confirm":
      if (!await secretEqual(callSecret ?? "", env("ELEVENLABS_CALL_CONFIRM_SECRET") ?? ""))
        throw new TradeError("UNAUTHORIZED", "Call confirmation unavailable.", 401);
      return callConfirm(store, token, body);
    case "dismiss-proposal": {
      const s = await requireSession(store, token);
      if (!keysAre(body, ["proposal_id"])) bad();
      validateProposalId(body.proposal_id);
      await store.dismissProposal(body.proposal_id, s.caller);
      return { ok: true };
    }
    case "order-result": {
      const s = await requireSession(store, token);
      if (!keysAre(body, ["proposal_id"])) bad();
      validateProposalId(body.proposal_id);
      return recordedResult(store, await ownedIntent(store, body.proposal_id, s));
    }
    case "end": return endSession(store, token);
    case "portfolio": return portfolio(store, body);
    default: throw new TradeError("NOT_FOUND", "Not found.", 404);
  }
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleBrowserTrading(req: Request, action: string): Promise<Response> {
  try {
    const callSecret = req.headers.get("x-call-secret") ?? "";
    if (action === "call-confirm" && !await secretEqual(callSecret, env("ELEVENLABS_CALL_CONFIRM_SECRET") ?? ""))
      return reply(401, { ok: false, error: "UNAUTHORIZED", message: "Call confirmation unavailable." });
    let body: unknown = {};
    if (req.method === "POST") {
      // JSON only: blocks cross-site form posts. Auth is a Bearer token kept in memory, never a cookie.
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return reply(415, { ok: false, error: "JSON_REQUIRED", message: "JSON required." });
      const text = await req.text();
      if (text.length > (action === "call-confirm" ? 131072 : 4096)) return reply(413, { ok: false, error: "TOO_LARGE", message: "Request too large." });
      try { body = text ? JSON.parse(text) : {}; } catch { return reply(400, { ok: false, error: "BAD_INPUT", message: "Invalid JSON." }); }
    }
    if (action === "session" && req.method === "POST" && !hasSupabase() && !hasBlob()) {
      // Quotes use public markets. Only a ledger-backed session receives a trading bearer.
      const signed = await fetchSignedUrl();
      if ("error" in signed) throw new TradeError("ELEVENLABS_UNAVAILABLE", signed.error, 502);
      return reply(200, { ok: true, voice_only: true, signed_url: signed.signed_url });
    }
    const token = action === "call-confirm" ? req.headers.get("x-trade-session-token") ?? undefined : /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const result = await runBrowserTrading({ action, method: req.method, token, body, callSecret });
    if (action === "call-confirm") return reply(200, { ...result, next_action: "wait_for_user", say: result.voice_say ?? result.say ?? (result.status === "EXECUTING" ? "Order pending." : result.message) });
    return reply(200, result);
  } catch (e) {
    if (e instanceof TradeError) {
      // ElevenLabs treats non-2xx as a failed webhook and may improvise a reason.
      // An authenticated order decision is a successful tool result, including a refusal.
      const decision = action === "call-confirm" && ["CONFIRMATION_REQUIRED", "EXECUTION_DISABLED"].includes(e.code);
      return reply(decision ? 200 : e.status, { ok: false, error: e.code, message: e.message, ...(decision && { say: e.message, next_action: "wait_for_user" }) });
    }
    console.error(JSON.stringify({ event: "browser_trading_error", action, error_name: (e as Error)?.name ?? null }));
    return reply(503, {
      ok: false, error: "SERVICE_UNAVAILABLE",
      message: action === "call-confirm" ? "Approval result unknown. Check open trades before trying again." : "Trading service unavailable.",
    });
  }
}

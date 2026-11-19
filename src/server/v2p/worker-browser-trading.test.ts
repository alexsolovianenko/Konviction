// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  db: {},
  executionEnabled: vi.fn(async () => process.env["EXECUTION_ENABLED"] === "true"),
  logActivity: vi.fn(async () => {}),
}));
vi.mock("./receipts", () => ({ createReceipt: vi.fn(async () => ({ id: "r", sha: "x" })) }));
vi.mock("./gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gemini")>()),
  getEvent: vi.fn(),
  gPrivate: vi.fn(),
  hasCredentials: () => true,
}));

import { getEvent, gPrivate } from "./gemini";
import { GLOBAL_GUARD, runBrowserTrading, type Store } from "./browser-trading";
import { mintSessionToken, verifySessionToken } from "./browser-session";

const PIN = "482915";
const SECRET = "test-voice-session-secret-0123456789abcdef";

// In-memory stand-in for the Supabase store (same contract as supabaseStore()).
function memoryStore() {
  const guards = new Map<string, { phone: string; pin_failures: number; locked_until: string | null }>();
  const intents = new Map<string, any>();
  const orders: any[] = [];
  const logs: { kind: string; caller: string | null; summary: string; detail?: unknown }[] = [];
  const cost = (it: any) => Number(it.notional_usd) + Number(it.est_fee_usd);
  const store = {
    guards, intents, orders, logs,
    async createSession(sid: string) { guards.set("session:" + sid, { phone: "session:" + sid, pin_failures: 0, locked_until: null }); },
    async getGuard(k: string) { return guards.get(k) ?? null; },
    async setGuard(k: string, f: number, l: string | null) { guards.set(k, { phone: k, pin_failures: f, locked_until: l }); },
    async supersede(caller: string) { for (const it of intents.values()) if (it.caller === caller && it.status === "PROPOSED") it.status = "SUPERSEDED"; },
    async insertIntent(row: any) { const id = randomUUID(); intents.set(id, { ...row, id, status: "PROPOSED" }); return id; },
    async claim(id: string, caller: string) {
      const it = intents.get(id);
      if (it && it.caller === caller && it.status === "PROPOSED" && it.side === "buy" && Date.parse(it.expires_at) > Date.now()) {
        it.status = "EXECUTING";
        return { ...it };
      }
      return null;
    },
    async getIntent(id: string) { return intents.get(id) ?? null; },
    async setIntentStatus(id: string, s: string) { intents.get(id).status = s; },
    async getOrderByIntent(id: string) { return orders.find((o) => o.intent_id === id) ?? null; },
    async saveOrder(row: any) { orders.push(row); },
    async committedUsd({ excludeIntentId }: { excludeIntentId?: string } = {}) {
      let t = 0;
      for (const o of orders) t += o.outcome_summary === "PENDING_UNKNOWN" ? cost(intents.get(o.intent_id)) : Number(o.filled_notional_usd ?? 0);
      for (const it of intents.values()) if (it.status === "EXECUTING" && it.id !== excludeIntentId) t += cost(it);
      return t;
    },
    log: async (kind: string, caller: string | null, summary: string, detail?: unknown) => { logs.push({ kind, caller, summary, detail }); },
    receipt: async () => ({ id: "r", sha: "x" }),
  };
  return store;
}

function quote(ask: string) {
  vi.mocked(getEvent).mockResolvedValue({
    event: {
      ticker: "BTC2611191200", title: "BTC price today at noon",
      contracts: [{
        instrumentSymbol: "GEMI-BTC2611191200-HI95000", label: "$95,000 or above", status: "active", marketState: "open",
        expiryDate: new Date(Date.now() + 86_400_000).toISOString(), prices: { buy: { yes: ask, no: "0.70" }, sell: { yes: "0.28", no: "0.66" } },
      }],
    },
  } as never);
}
const signedUrl = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_x&conversation_signature=sig&conversation_id=conv_123";
const elevenLabs = vi.fn(async () => Response.json({ signed_url: signedUrl }));
const order = { event_ticker: "BTC2611191200", contract_symbol: "GEMI-BTC2611191200-HI95000", outcome: "yes", quantity: 1, limit_price: 0.31 };

let store: ReturnType<typeof memoryStore>;
const run = (action: string, body: unknown = {}, token?: string, method = "POST") =>
  runBrowserTrading({ action, method, ...(token && { token }), body }, store as unknown as Store, elevenLabs as unknown as typeof fetch);
const startSession = async () => (await run("session")) as { session_token: string; session_id: string; signed_url: string };
const geminiOrderCalls = () => vi.mocked(gPrivate).mock.calls.filter(([p]) => p === "/v1/prediction-markets/order");

beforeEach(() => {
  store = memoryStore();
  vi.stubEnv("VOICE_SESSION_SECRET", SECRET);
  vi.stubEnv("ELEVENLABS_API_KEY", "xi-test-key");
  vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_x");
  vi.stubEnv("DEMO_PIN", PIN);
  vi.stubEnv("EXECUTION_ENABLED", "true");
  vi.stubEnv("MAX_DAILY_USD", "50");
  vi.mocked(gPrivate).mockReset();
  vi.mocked(gPrivate).mockResolvedValue({
    ok: true, status: 201, text: "",
    data: { orderId: "73797746498585286", status: "filled", filledQuantity: "1", remainingQuantity: "0", avgExecutionPrice: "0.30" },
  });
  elevenLabs.mockClear();
  quote("0.30");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("verified voice session", () => {
  it("mints a server-signed token only together with an ElevenLabs signed URL", async () => {
    const s = await startSession();
    expect(s.signed_url).toBe(signedUrl);
    const [url, init] = elevenLabs.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toContain("agent_id=agent_x");
    expect(new Headers(init.headers).get("xi-api-key")).toBe("xi-test-key");
    expect(init.redirect).toBe("manual"); // Cloudflare Workers reject redirect: "error"
    expect(JSON.stringify(s)).not.toContain("xi-test-key");
    const claims = await verifySessionToken(s.session_token);
    expect(claims).toMatchObject({ sid: s.session_id, cid: "conv_123" });
    expect(store.guards.has("session:" + s.session_id)).toBe(true);
  });

  it("refuses to start without a strong session secret", async () => {
    vi.stubEnv("VOICE_SESSION_SECRET", "short");
    await expect(run("session")).rejects.toMatchObject({ code: "VOICE_UNCONFIGURED" });
    expect(elevenLabs).not.toHaveBeenCalled();
  });

  it("rejects tampered, foreign and expired tokens", async () => {
    const s = await startSession();
    const [body, sig] = s.session_token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, sid: randomUUID(), cid: null, iat: Date.now(), exp: Date.now() + 3600_000 })).toString("base64url");
    expect(await verifySessionToken(`${forged}.${sig}`)).toBeNull();
    expect(await verifySessionToken(`${body}.${sig!.slice(0, -2)}xx`)).toBeNull();
    const expired = await mintSessionToken({ v: 1, sid: randomUUID(), cid: null, iat: Date.now() - 7200_000, exp: Date.now() - 1 });
    expect(await verifySessionToken(expired)).toBeNull();
    vi.stubEnv("VOICE_SESSION_SECRET", "a-completely-different-secret-0123456789");
    expect(await verifySessionToken(s.session_token)).toBeNull();
  });

  it("requires a session for proposals and approvals", async () => {
    await expect(run("proposals", order)).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    await expect(run("approve", { proposal_id: randomUUID(), pin: PIN })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("a revoked (ended) session can no longer approve", async () => {
    const s = await startSession();
    const p = (await run("proposals", order, s.session_token)) as any;
    await run("end", {}, s.session_token);
    await expect(run("approve", { proposal_id: p.proposal.proposal_id, pin: PIN }, s.session_token)).rejects.toMatchObject({ code: "LOCKED" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });
});

describe("proposals (voice-reachable) never submit orders", () => {
  it("quotes Gemini and saves a proposal bound to the session and conversation", async () => {
    const s = await startSession();
    const r = (await run("proposals", order, s.session_token)) as any;
    expect(r.ok).toBe(true);
    expect(r.proposal).toMatchObject({ quantity: 1, limit_price: 0.31, quote_price: 0.3, outcome: "yes" });
    expect(r.proposal.readback).toContain("Buy 1 YES");
    const it = store.intents.get(r.proposal.proposal_id);
    expect(it).toMatchObject({ caller: "session:" + s.session_id, conversation_id: "conv_123", status: "PROPOSED", side: "buy" });
    expect(gPrivate).not.toHaveBeenCalled();
  });

  it("rejects malformed or extra parameters", async () => {
    const s = await startSession();
    for (const bad of [{ ...order, side: "sell" }, { ...order, quantity: 1.5 }, { ...order, limit_price: 0.315 }, { ...order, contract_symbol: "../x" }]) {
      await expect(run("proposals", bad, s.session_token)).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
  });

  it("refuses a proposal that would exceed the daily ledger", async () => {
    vi.stubEnv("MAX_DAILY_USD", "1");
    store.orders.push({ intent_id: "old", outcome_summary: "FILLED", filled_notional_usd: 0.9 });
    const s = await startSession();
    const r = (await run("proposals", order, s.session_token)) as any;
    expect(r).toMatchObject({ ok: false, error: "CAP_EXCEEDED" });
    expect(store.intents.size).toBe(0);
  });
});

describe("approval: the only order-submission path", () => {
  async function proposed() {
    const s = await startSession();
    const r = (await run("proposals", order, s.session_token)) as any;
    return { s, id: r.proposal.proposal_id as string };
  }

  it("submits exactly one IOC limit order after a correct typed PIN and returns Gemini's order id", async () => {
    const { s, id } = await proposed();
    const r = (await run("approve", { proposal_id: id, pin: PIN }, s.session_token)) as any;
    expect(r).toMatchObject({ ok: true, outcome_summary: "FILLED", order_id: "73797746498585286", exchange_status: "filled" });
    expect(geminiOrderCalls()).toHaveLength(1);
    expect(geminiOrderCalls()[0]?.[1]).toEqual({
      symbol: "GEMI-BTC2611191200-HI95000", orderType: "limit", side: "buy", outcome: "yes",
      quantity: "1", price: "0.31", timeInForce: "immediate-or-cancel", makerOrCancel: false,
    });
    expect(store.intents.get(id).status).toBe("DONE");
    expect(store.orders[0]).toMatchObject({ gemini_order_id: "73797746498585286", outcome_summary: "FILLED" });
  });

  it("replaying an approval returns the recorded result and never places a second order", async () => {
    const { s, id } = await proposed();
    await run("approve", { proposal_id: id, pin: PIN }, s.session_token);
    const again = (await run("approve", { proposal_id: id, pin: PIN }, s.session_token)) as any;
    expect(again).toMatchObject({ replayed: true, order_id: "73797746498585286" });
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("another session cannot approve someone else's proposal", async () => {
    const { id } = await proposed();
    const other = await startSession();
    await expect(run("approve", { proposal_id: id, pin: PIN }, other.session_token)).rejects.toMatchObject({ code: "UNKNOWN_PROPOSAL" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("wrong PINs are refused, never logged, and lock the session after 3 misses", async () => {
    const { s, id } = await proposed();
    for (let i = 0; i < 3; i++) {
      await expect(run("approve", { proposal_id: id, pin: "000000" }, s.session_token)).rejects.toMatchObject({ code: "WRONG_PIN" });
    }
    await expect(run("approve", { proposal_id: id, pin: PIN }, s.session_token)).rejects.toMatchObject({ code: "LOCKED" });
    expect(geminiOrderCalls()).toHaveLength(0);
    const logged = JSON.stringify(store.logs);
    expect(logged).not.toContain("000000");
    expect(logged).not.toContain(PIN);
    expect(logged).not.toContain(s.session_token);
  });

  it("locks approval account-wide after 10 wrong PINs across sessions", async () => {
    for (let i = 0; i < 10; i++) {
      const s = await startSession();
      await expect(run("approve", { proposal_id: randomUUID(), pin: "111111" }, s.session_token)).rejects.toMatchObject({ code: "WRONG_PIN" });
    }
    expect(Date.parse(store.guards.get(GLOBAL_GUARD)!.locked_until!)).toBeGreaterThan(Date.now());
    const { s, id } = await proposed();
    await expect(run("approve", { proposal_id: id, pin: PIN }, s.session_token)).rejects.toMatchObject({ code: "LOCKED" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("does nothing when execution is switched off", async () => {
    const { s, id } = await proposed();
    vi.stubEnv("EXECUTION_ENABLED", "false");
    await expect(run("approve", { proposal_id: id, pin: PIN }, s.session_token)).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("refuses an expired proposal", async () => {
    const { s, id } = await proposed();
    store.intents.get(id).expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(run("approve", { proposal_id: id, pin: PIN }, s.session_token)).rejects.toMatchObject({ code: "INACTIVE" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("re-checks the shared daily ledger at approval time", async () => {
    const { s, id } = await proposed();
    vi.stubEnv("MAX_DAILY_USD", "1");
    store.orders.push({ intent_id: "phone", outcome_summary: "FILLED", filled_notional_usd: 0.95 }); // e.g. another channel filled meanwhile
    await expect(run("approve", { proposal_id: id, pin: PIN }, s.session_token)).rejects.toMatchObject({ code: "CAP_EXCEEDED" });
    expect(store.intents.get(id).status).toBe("REJECTED");
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("an unconfirmed outcome is reported as unknown and stays reserved in the ledger", async () => {
    vi.mocked(gPrivate).mockResolvedValue({ ok: false, status: 0, data: null, text: "", timedOut: true, error: "Gemini request timed out." });
    const { s, id } = await proposed();
    const r = (await run("approve", { proposal_id: id, pin: PIN }, s.session_token)) as any;
    expect(r.outcome_summary).toBe("PENDING_UNKNOWN");
    expect(r.say).not.toMatch(/filled:/i);
    expect(await store.committedUsd()).toBeGreaterThan(0.3);
  });

  it("never claims a fill when Gemini reports zero filled quantity", async () => {
    vi.mocked(gPrivate).mockResolvedValue({ ok: true, status: 201, text: "", data: { orderId: "1", status: "cancelled", filledQuantity: "0", remainingQuantity: "1" } });
    const { s, id } = await proposed();
    const r = (await run("approve", { proposal_id: id, pin: PIN }, s.session_token)) as any;
    expect(r).toMatchObject({ outcome_summary: "NOT_FILLED", order_id: "1" });
    expect(r.say).toContain("cancelled");
  });
});

describe("Gemini order evidence", () => {
  const ack = (data: unknown, status = 201) => ({ ok: status >= 200 && status < 300, status, text: "", data });
  const approveWith = async (...responses: unknown[]) => {
    const { s, id } = await (async () => {
      const s = await startSession();
      const r = (await run("proposals", order, s.session_token)) as any;
      return { s, id: r.proposal.proposal_id as string };
    })();
    for (const r of responses) vi.mocked(gPrivate).mockResolvedValueOnce(r as any);
    return (await run("approve", { proposal_id: id, pin: PIN }, s.session_token)) as any;
  };

  it("treats a fill without a Gemini order id as unknown and keeps it reserved", async () => {
    const r = await approveWith(ack({ status: "filled", filledQuantity: "1", remainingQuantity: "0" }));
    expect(r).toMatchObject({ outcome_summary: "PENDING_UNKNOWN", order_id: null, filled_quantity: null });
    expect(r.say).not.toMatch(/filled:/i);
    expect(await store.committedUsd()).toBeGreaterThan(0.3);
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("refuses evidence for a different contract, side, outcome or size", async () => {
    for (const wrong of [{ symbol: "GEMI-OTHER-X" }, { side: "sell" }, { outcome: "no" }, { quantity: "5" }]) {
      store = memoryStore();
      const r = await approveWith(ack({ orderId: "9", status: "filled", filledQuantity: "1", remainingQuantity: "0", ...wrong }));
      expect(r.outcome_summary).toBe("PENDING_UNKNOWN");
      expect(r.order_id).toBeNull();
    }
  });

  it("refuses inconsistent fill figures", async () => {
    for (const bad of [
      { filledQuantity: "2", remainingQuantity: "0" },
      { filledQuantity: "1", remainingQuantity: "1" },
      { filledQuantity: "1", remainingQuantity: "0", avgExecutionPrice: "0.45" },
    ]) {
      store = memoryStore();
      const r = await approveWith(ack({ orderId: "9", status: "filled", ...bad }));
      expect(r).toMatchObject({ outcome_summary: "PENDING_UNKNOWN", filled_quantity: null, avg_price: null });
    }
  });

  it("an open acknowledgement is resolved from order history, never assumed", async () => {
    const r = await approveWith(
      ack({ orderId: "77", status: "open", filledQuantity: "0", remainingQuantity: "1" }),
      ack({ orders: [{ orderId: "77", symbol: order.contract_symbol, side: "buy", outcome: "yes", status: "filled", filledQuantity: "1", remainingQuantity: "0", avgExecutionPrice: "0.30" }] }, 200),
    );
    expect(r).toMatchObject({ outcome_summary: "FILLED", order_id: "77", filled_quantity: 1 });
    expect(vi.mocked(gPrivate).mock.calls.at(-1)?.[0]).toBe("/v1/prediction-markets/orders/history");
  });

  it("an open order missing from history stays unknown and reserved", async () => {
    const r = await approveWith(
      ack({ orderId: "78", status: "open", filledQuantity: "0", remainingQuantity: "1" }),
      ack({ orders: [] }, 200),
    );
    expect(r).toMatchObject({ outcome_summary: "PENDING_UNKNOWN", order_id: "78" });
    expect(await store.committedUsd()).toBeGreaterThan(0.3);
  });

  it("a refused redirect is unknown, not a rejection", async () => {
    const r = await approveWith({ ok: false, status: 307, text: "", data: null, error: "Gemini returned a redirect; refusing to follow it." });
    expect(r.outcome_summary).toBe("PENDING_UNKNOWN");
    expect(await store.committedUsd()).toBeGreaterThan(0.3);
  });
});

it("prepares a budget buy within per-order and quantity limits without submitting", async () => {
  vi.stubEnv("MAX_ORDER_USD", "25");
  vi.stubEnv("MAX_QUANTITY", "100");
  const s = await startSession();
  const { quantity: _count, ...terms } = order;
  const budgetBuy = { ...terms, budget_usd: 1000 };
  const moneyCapped = await run("proposals", budgetBuy, s.session_token);
  expect(moneyCapped).toMatchObject({ ok: true, proposal: { quantity: 76, limit_price: 0.31, notional_usd: 23.56, est_fee_usd: 1.14 } });
  vi.stubEnv("MAX_QUANTITY", "7");
  expect(await run("proposals", budgetBuy, s.session_token)).toMatchObject({ ok: true, proposal: { quantity: 7 } });
  await expect(run("proposals", { ...budgetBuy, quantity: 1 }, s.session_token)).rejects.toMatchObject({ code: "BAD_INPUT" });
  await expect(run("proposals", terms, s.session_token)).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(geminiOrderCalls()).toHaveLength(0);
});

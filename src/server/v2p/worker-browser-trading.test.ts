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
  gPublic: vi.fn(),
  hasCredentials: () => true,
  getUsdAvailable: async () => ({ usd: 5 }),
}));

import { getEvent, gPrivate, gPublic } from "./gemini";
import { spokenProposal } from "../../../server/spoken-proposal.mjs";
import { runBrowserTrading, type Store } from "./browser-trading";
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
      if (it && it.caller === caller && it.status === "PROPOSED" && ["buy","sell"].includes(it.side) && Date.parse(it.expires_at) > Date.now()) {
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
const run = (action: string, body: unknown = {}, token?: string, method = "POST", callSecret?: string) =>
  runBrowserTrading({ action, method, ...(token && { token }), body, ...(callSecret !== undefined && { callSecret }) }, store as unknown as Store, elevenLabs as unknown as typeof fetch);
const startSession = async () => (await run("session")) as { session_token: string; session_id: string; signed_url: string };
const geminiOrderCalls = () => vi.mocked(gPrivate).mock.calls.filter(([p]) => p === "/v1/prediction-markets/order");

function conversationEntries(id: string, answer = "confirm") {
  const prepared = store.intents.get(id);
  return [
    {role:"tool",tool_results:[{tool_name:"prepare_sandbox_buy",result_value:JSON.stringify({ok:true,proposal_id:id})}]},
    {role:"agent",message:prepared ? spokenProposal(prepared) : "Unknown proposal"},
    {role:"user",message:answer},
    {role:"agent",tool_requests:[{tool_name:"confirm_hosted_sandbox_buy"}]},
  ];
}
function callConfirm(id: string, token: string, overrides = {}, secret = SECRET) {
  return run("call-confirm", {proposal_id:id, conversation_id:"conv_123", is_text_only:false,
    history:JSON.stringify({entries:conversationEntries(id)}), ...overrides}, token, "POST", secret);
}

beforeEach(() => {
  store = memoryStore();
  vi.stubEnv("SUPABASE_URL", "https://test.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only");
  vi.stubEnv("VOICE_SESSION_SECRET", SECRET);
  vi.stubEnv("ELEVENLABS_API_KEY", "xi-test-key");
  vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_x");
  vi.stubEnv("DEMO_PIN", PIN);
  vi.stubEnv("ELEVENLABS_CALL_CONFIRM_SECRET", SECRET);
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
    await expect(run("approve", { proposal_id: randomUUID(), pin: PIN })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("a revoked (ended) session can no longer approve", async () => {
    const s = await startSession();
    const p = (await run("proposals", order, s.session_token)) as any;
    await run("end", {}, s.session_token);
    await expect(callConfirm(p.proposal.proposal_id, s.session_token)).rejects.toMatchObject({ code: "LOCKED" });
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

  it("exits the available position at market on one confirmed call, even after reaching the buy budget", async () => {
    vi.stubEnv("MAX_DAILY_USD", "1");
    store.orders.push({intent_id:"previous-buy",outcome_summary:"FILLED",filled_notional_usd:1});
    vi.mocked(gPrivate).mockImplementation(async (path) => ({
      ok:true, status:200, text:"", data:path.endsWith("/positions")
        ? {positions:[{symbol:order.contract_symbol,outcome:"yes",totalQuantity:"4",quantityOnHold:"1"}]}
        : {orderId:"exit123",filledQuantity:"3",avgExecutionPrice:"0.28",status:"filled"},
    }));
    const s = await startSession();
    const request = {event_ticker:order.event_ticker,contract_symbol:order.contract_symbol,outcome:"yes",side:"sell",order_mode:"market",close_all:true};
    const preview = await run("proposals",request,s.session_token) as any;
    expect(preview.proposal.voice_readback).toBe("Sell three yes at market. Confirm?");
    expect(geminiOrderCalls()).toHaveLength(0);
    const result = await callConfirm(preview.proposal.proposal_id,s.session_token) as any;
    expect(result).toMatchObject({outcome_summary:"FILLED",filled_quantity:3});
    expect(geminiOrderCalls()[0]?.[1]).toMatchObject({side:"sell",outcome:"yes",price:"0.28",quantity:"3",timeInForce:"immediate-or-cancel"});
    await callConfirm(preview.proposal.proposal_id,s.session_token);
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("reads a clockless hourly market with its actual expiry and exact decimal threshold", async () => {
    const expiry = new Date();
    expiry.setUTCDate(expiry.getUTCDate() + 1);
    expiry.setUTCHours(22, 0, 0, 0);
    vi.mocked(getEvent).mockResolvedValue({event:{
      ticker:order.event_ticker,title:"XRP price tomorrow",contracts:[{
        instrumentSymbol:order.contract_symbol,label:"$0.9721 or above",expiryDate:expiry.toISOString(),
        status:"active",marketState:"open",prices:{buy:{yes:"0.30"}},
      }],
    }} as never);
    const s = await startSession();
    const request = {event_ticker:order.event_ticker,contract_symbol:order.contract_symbol,outcome:"yes",budget_usd:1,order_mode:"market"};
    const {proposal} = await run("proposals",request,s.session_token) as any;
    const clock = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric"}).format(expiry);
    expect(proposal.voice_readback).toContain(clock + " Eastern");
    expect(proposal.voice_readback).toContain("zero point nine seven two one dollars or above");
  });

  it("binds buy now to the exact spoken immediate quote and submits once", async () => {
    const s = await startSession();
    const request = {event_ticker:order.event_ticker,contract_symbol:order.contract_symbol,outcome:"yes",budget_usd:0.35};
    const {proposal} = await run("proposals", {...request,order_mode:"market"},s.session_token) as any;
    expect(proposal.voice_readback).toContain("Bitcoin price today at noon, ninety five thousand dollars or above");
    expect(proposal.voice_readback).toContain("thirty percent market-implied");
    expect(proposal.voice_readback).not.toContain("GEMI-");
    const entries = conversationEntries(proposal.proposal_id,"Buy now.");
    const confirm = (turns: typeof entries) => callConfirm(proposal.proposal_id, s.session_token, {history:JSON.stringify({entries:turns})});
    const tampered = structuredClone(entries);
    tampered[1]!.message = tampered[1]!.message!.replace("thirty cents each", "forty cents each");
    await expect(confirm(tampered)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
    expect(geminiOrderCalls()).toHaveLength(0);
    expect(await confirm(entries)).toMatchObject({outcome_summary:"FILLED",voice_say:"$0.30 filled before fees."});
    await confirm(entries);
    expect(geminiOrderCalls()).toHaveLength(1);
    const limit = (await run("proposals",{...request,limit_price:.25},s.session_token) as any).proposal;
    await expect(callConfirm(limit.proposal_id,s.session_token,{history:JSON.stringify({entries:conversationEntries(limit.proposal_id,"Buy now")})})).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("rejects malformed or extra parameters", async () => {
    const s = await startSession();
    for (const bad of [{ ...order, side: "borrow" }, { ...order, close_all: true }, { ...order, quantity: 1.5 }, { ...order, limit_price: 0.315 }, { ...order, contract_symbol: "../x" }]) {
      await expect(run("proposals", bad, s.session_token)).rejects.toMatchObject({ code: "BAD_INPUT" });
    }
  });

  it("prepares independently of previous sandbox spending", async () => {
    vi.stubEnv("MAX_DAILY_USD", "1");
    store.orders.push({ intent_id: "old", outcome_summary: "FILLED", filled_notional_usd: 0.9 });
    const s = await startSession();
    const r = (await run("proposals", order, s.session_token)) as any;
    expect(r).toMatchObject({ok:true});
    expect(store.intents.size).toBe(1);
  });
});

describe("approval: the only order-submission path", () => {
  async function proposed() {
    const s = await startSession();
    const r = (await run("proposals", order, s.session_token)) as any;
    return { s, id: r.proposal.proposal_id as string };
  }

  it("submits exactly one resting limit order after a provider-attested spoken confirmation and returns Gemini's order id", async () => {
    const { s, id } = await proposed();
    const r = (await callConfirm(id, s.session_token)) as any;
    expect(r).toMatchObject({ ok: true, outcome_summary: "FILLED", order_id: "73797746498585286", exchange_status: "filled" });
    expect(geminiOrderCalls()).toHaveLength(1);
    expect(geminiOrderCalls()[0]?.[1]).toEqual({
      symbol: "GEMI-BTC2611191200-HI95000", orderType: "limit", side: "buy", outcome: "yes",
      quantity: "1", price: "0.31", timeInForce: "good-til-cancel", makerOrCancel: false,
    });
    expect(store.intents.get(id).status).toBe("DONE");
    expect(store.orders[0]).toMatchObject({ gemini_order_id: "73797746498585286", outcome_summary: "FILLED" });
  });

  it("replaying an approval returns the recorded result and never places a second order", async () => {
    const { s, id } = await proposed();
    await callConfirm(id, s.session_token);
    const again = (await callConfirm(id, s.session_token, {history:JSON.stringify({entries:[...conversationEntries(id), {role:"agent",message:"Filled."}]})})) as any;
    expect(again).toMatchObject({ replayed: true, order_id: "73797746498585286" });
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("accepts Confirmed on a second purchase in the same call and submits each proposal once", async () => {
    const {s,id} = await proposed();
    const first = conversationEntries(id);
    await callConfirm(id,s.session_token);
    const second = await run("proposals",order,s.session_token) as any;
    const nextId = second.proposal.proposal_id;
    const history = JSON.stringify({entries:[...first,{role:"agent",message:"Filled."},{role:"user",message:"Buy another."},...conversationEntries(nextId,"Confirmed.")]});
    expect(await callConfirm(nextId,s.session_token,{history})).toMatchObject({outcome_summary:"FILLED"});
    expect(await callConfirm(nextId,s.session_token,{history})).toMatchObject({replayed:true});
    expect(geminiOrderCalls()).toHaveLength(2);
  });

  it("silences an automatic webhook retry following a refusal in the same turn", async () => {
    const {s,id} = await proposed();
    const entries = [...conversationEntries(id,"yes but change the size"),{role:"tool",tool_results:[{tool_name:"confirm_hosted_sandbox_buy",result_value:"Confirmation missed."}]},{role:"user",message:"..."}];
    expect(await callConfirm(id,s.session_token,{history:JSON.stringify({entries})})).toMatchObject({say:"",next_action:"wait_for_user"});
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("another session cannot approve someone else's proposal", async () => {
    const { id } = await proposed();
    const other = await startSession();
    await expect(callConfirm(id, other.session_token)).rejects.toMatchObject({ code: "UNKNOWN_PROPOSAL" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("rejects client approval, missing provider credentials, text-only calls and mismatched conversation IDs", async () => {
    const { s, id } = await proposed();
    await expect(run("approve",{proposal_id:id,pin:PIN},s.session_token)).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(callConfirm(id,s.session_token,{},"incorrect")).rejects.toMatchObject({code:"UNAUTHORIZED"});
    for (const overrides of [{is_text_only:true},{conversation_id:"conv_other"}])
      await expect(callConfirm(id,s.session_token,overrides)).rejects.toMatchObject({code:"CALL_REQUIRED"});
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("requires a fresh proposal-bound readback and unambiguous confirm; polling never submits", async () => {
    const {s,id} = await proposed();
    const turns = conversationEntries(id);
    const cases = [
      conversationEntries(id,"yes but change the price"), turns.slice(1),
      [conversationEntries(randomUUID())[0], ...turns.slice(1)],
      [turns[0], {role:"agent",message:"Some different order"}, ...turns.slice(2)],
      [turns[0], {...turns[1],interrupted:true}, ...turns.slice(2)],
      [...turns,{role:"user",message:"no"}]
    ];
    for(const entries of cases)
      await expect(callConfirm(id,s.session_token,{history:JSON.stringify({entries})})).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
    expect(await run("order-result", {proposal_id:id},s.session_token)).toMatchObject({ok:true,status:"PROPOSED"});
    expect(geminiOrderCalls()).toHaveLength(0);
    vi.stubEnv("DEMO_PIN","");
    await callConfirm(id,s.session_token);
    expect(await run("order-result", {proposal_id:id},s.session_token)).toMatchObject({outcome_summary:"FILLED"});
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("allows an exact repeated readback after hesitation but requires new preparation for changed terms", async () => {
    const {s,id} = await proposed();
    const turns = conversationEntries(id);
    const repeated = (message:string) => ({history:JSON.stringify({entries:[
      ...turns.slice(0,2), {role:"user", message}, ...turns.slice(1)
    ]})});
    await expect(callConfirm(id,s.session_token,repeated("No, change the size."))).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
    expect(await callConfirm(id,s.session_token,repeated("Maybe. Did you buy it already?"))).toMatchObject({outcome_summary:"FILLED"});
  });
  it("accepts a valid confirmation after an earlier interrupted preparation", async () => {
    const { s, id } = await proposed();
    const entries = [
      { role: "tool", tool_results: [{ tool_name: "prepare_sandbox_buy", result_value: "Tool execution was abandoned due to user input" }] },
      ...conversationEntries(id),
    ];
    expect(await callConfirm(id, s.session_token, { history: JSON.stringify({ entries }) })).toMatchObject({ outcome_summary: "FILLED" });
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("reads the shared balance and position fields without a PIN or voice session", async () => {
    vi.stubEnv("DEMO_PIN", "");
    vi.mocked(gPrivate).mockResolvedValue({ ok: true, status: 200, text: "",
      data: { orders: [], positions: [{symbol:"C",outcome:"yes",unrealizedPnl:".15",secret:"private",contractMetadata:{eventName:"Oil",contractName:"Up"}}] } });
    const account = await run("portfolio", {});
    expect(account.usd_available).toBe(5);
    expect(account.positions.rows).toEqual([{symbol:"C",outcome:"yes",unrealizedPnl:".15",event_title:"Oil",contract_label:"Up"}]);
    expect(account.settlements.rows).toHaveLength(1);
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("does nothing when execution is switched off", async () => {
    const { s, id } = await proposed();
    vi.stubEnv("EXECUTION_ENABLED", "false");
    await expect(callConfirm(id, s.session_token)).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("refuses an expired proposal", async () => {
    const { s, id } = await proposed();
    store.intents.get(id).expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await callConfirm(id, s.session_token)).toMatchObject({ok:false,error:"EXPIRED"});
    expect(geminiOrderCalls()).toHaveLength(0);
  });

  it("executes the authorized order regardless of earlier sandbox spending", async () => {
    const { s, id } = await proposed();
    vi.stubEnv("MAX_DAILY_USD", "1");
    store.orders.push({ intent_id: "phone", outcome_summary: "FILLED", filled_notional_usd: 0.95 }); // e.g. another channel filled meanwhile
    expect(await callConfirm(id, s.session_token)).toMatchObject({outcome_summary:"FILLED"});
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("an unconfirmed outcome is reported as unknown and stays reserved in the ledger", async () => {
    vi.mocked(gPrivate).mockResolvedValue({ ok: false, status: 0, data: null, text: "", timedOut: true, error: "Gemini request timed out." });
    const { s, id } = await proposed();
    const r = (await callConfirm(id, s.session_token)) as any;
    expect(r.outcome_summary).toBe("PENDING_UNKNOWN");
    expect(r.remainder_buy).toBeUndefined();
    expect(r.say).not.toMatch(/filled:/i);
    expect(await store.committedUsd()).toBeGreaterThan(0.3);
  });

  it("reports a cancelled order's partial fill and leaves the remainder unsubmitted", async () => {
    const { s, id } = await proposed();
    vi.mocked(gPrivate).mockResolvedValue({ ok: true, status: 201, text: "", data: { orderId: "1", status: "cancelled", filledQuantity: "0.25", remainingQuantity: "0.75" } });
    const result = await callConfirm(id, s.session_token);
    expect(result.remainder_buy).toBeUndefined();
    expect(result.say).toContain("quantity at your limit was unknown");
    expect(result).toMatchObject({ outcome_summary: "PARTIAL", filled_quantity: 0.25, voice_say: "Filled 0.25 of 1.", say: expect.stringContaining("0.25 of 1") });
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it.each(["0", "1"])("reproposes the confirmed whole remainder after %s executions with the original cap", async (filled) => {
    const s = await startSession();
    const { proposal } = await run("proposals", {...order, quantity: 5}, s.session_token);
    vi.mocked(gPrivate).mockResolvedValue({ok:true, status:201, text:"", data:{
      orderId:"123", status:"cancelled", filledQuantity:filled, remainingQuantity:"0",
      avgExecutionPrice: filled === "0" ? null : ".30",
    }});
    vi.mocked(gPublic).mockResolvedValueOnce({ok:true,status:200,text:"",data:{asks:[{price:".31",amount:"2"}]}});
    const approval = {proposal_id:proposal.proposal_id, pin:PIN};
    const result = await callConfirm(approval.proposal_id, s.session_token);
    expect(result.remainder_buy).toEqual({...order, quantity:5-Number(filled)});
    expect(result.say).toContain("only 2 contracts at or below your limit");
    expect((await callConfirm(approval.proposal_id, s.session_token)).remainder_buy).toEqual(result.remainder_buy);
    quote(".45");
    const retry = await run("proposals", result.remainder_buy, s.session_token);
    expect(retry.proposal).toMatchObject({quantity:5-Number(filled), quote_price:.45, limit_price:.31});
    expect(retry.proposal.proposal_id).not.toBe(proposal.proposal_id);
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("explains a venue-reported liquidity rejection and leaves unknown depth unspecified", async () => {
    const { s, id } = await proposed();
    vi.mocked(gPrivate).mockResolvedValue({ ok: false, status: 400, text: "", data: { reason: "InsufficientLiquidity" } });
    const result = await callConfirm(id, s.session_token);
    expect(result).toMatchObject({ ok: false, outcome_summary: "EXCHANGE_REJECTED", say: expect.stringContaining("fresh quote"), voice_say: "Insufficient liquidity at that price." });
    expect(geminiOrderCalls()).toHaveLength(1);
  });

  it("never claims a fill when Gemini reports zero filled quantity", async () => {
    vi.mocked(gPrivate).mockResolvedValue({ ok: true, status: 201, text: "", data: { orderId: "1", status: "cancelled", filledQuantity: "0", remainingQuantity: "1" } });
    const { s, id } = await proposed();
    const r = (await callConfirm(id, s.session_token)) as any;
    expect(r).toMatchObject({ outcome_summary: "NOT_FILLED", order_id: "1" });
    expect(r.say).toContain("cancelled");
  });
});

it("sizes a large budget to the caller’s own price and estimated fees without application spending limits", async () => {
  vi.stubEnv("MAX_ORDER_USD", "25");
  vi.stubEnv("MAX_QUANTITY", "100");
  const s = await startSession();
  const { quantity: _count, ...terms } = order;
  const budgetBuy = { ...terms, budget_usd: 1000 };
  vi.stubEnv("MAX_LIMIT_PRICE","0.05");
  const {proposal} = await run("proposals", budgetBuy, s.session_token) as any;
  expect(proposal.quantity).toBeGreaterThan(3000);
  expect(proposal.budget_usd).toBe(1000);
  expect(proposal.notional_usd + proposal.est_fee_usd).toBeLessThanOrEqual(1000);
  expect(proposal.notional_usd + proposal.est_fee_usd + proposal.limit_price).toBeGreaterThan(1000);
  await expect(run("proposals", { ...budgetBuy, quantity: 1 }, s.session_token)).rejects.toMatchObject({ code: "BAD_INPUT" });
  await expect(run("proposals", terms, s.session_token)).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(geminiOrderCalls()).toHaveLength(0);
});

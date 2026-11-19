// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
// @ts-expect-error JavaScript repository is used by the local Node service.
import { SQLiteRepository } from "../../../server/repository.mjs";
// @ts-expect-error JavaScript service is used by the local Node launcher.
import { browserTrading } from "../../../server/browser-trading.mjs";
import { getEvent, gPrivate, gPublic } from "./gemini";

vi.mock("./gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gemini")>()),
  getEvent: vi.fn(),
  gPrivate: vi.fn(),
  gPublic: vi.fn(),
  hasCredentials: () => true,
}));
const input = {
  event_ticker: "E",
  contract_symbol: "GEMI-E-C",
  outcome: "yes",
  quantity: 2,
  limit_price: 0.4,
};
const pin = "7314";
let repo: InstanceType<typeof SQLiteRepository>, run: ReturnType<typeof browserTrading>;
function token() {
  const t = randomUUID(),
    id = randomUUID(),
    now = Date.now();
  repo.create(id, createHash("sha256").update(t).digest("hex"), now, now + 3600000, now + 60000);
  repo.touch(id, now, "active", "test");
  return t;
}
function quote(price: string) {
  vi.mocked(getEvent).mockResolvedValue({
    event: {
      ticker: "E",
      title: "Example event",
      contracts: [
        {
          instrumentSymbol: "GEMI-E-C",
          label: "Option",
          status: "active",
          marketState: "open",
          expiryDate: new Date(Date.now() + 86400000).toISOString(),
          prices: { buy: { yes: price } },
        },
      ],
    },
  });
}
const propose = (t: string, key = randomUUID(), body: object = input) =>
  run({ method: "POST", path: "proposals", token: t, key, body });
function approve(t: string, id: string, answer = "confirm") {
  const owner = repo.authenticate(createHash("sha256").update(t).digest("hex")).id;
  const row = repo.db.prepare("SELECT terms FROM browser_proposals WHERE owner=? AND id=?").get(owner, id);
  let seq = repo.db.prepare("SELECT confirmation_seq FROM browser_voice_approvals WHERE owner=? AND proposal=?").get(owner, id)?.confirmation_seq;
  if (!seq) {
    seq = (repo.transcript(owner).at(-1)?.seq ?? 0) + 2;
    repo.append(owner, { seq: seq - 1, role: "agent", text: row ? JSON.parse(row.terms).voice_readback : "" }, Date.now());
    repo.append(owner, { seq, role: "user", text: answer }, Date.now());
  }
  return run({ method: "POST", path: "voice-confirm", token: t, body: { proposal_id: id, confirmation_seq: seq } });
}
beforeEach(() => {
  vi.stubEnv("EXECUTION_ENABLED", "true");
  vi.stubEnv("DEMO_PIN", pin);
  vi.stubEnv("MAX_DAILY_USD", "50");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External requests forbidden in fixture tests");
    }),
  );
  repo = new SQLiteRepository(":memory:");
  run = browserTrading(repo);
  quote(".39");
  vi.mocked(gPrivate).mockResolvedValue({
    ok: true,
    status: 200,
    text: "",
    data: { orderId: "1", filledQuantity: "2", avgExecutionPrice: ".39" },
  });
});
afterEach(() => {
  repo.close();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("stores exact fresh terms, deduplicates proposals, rejects changed parameters and ignores client identities", async () => {
  const t = token(),
    key = randomUUID();
  await expect(propose(t, key, { ...input, caller: "other" })).rejects.toMatchObject({
    code: "BAD_INPUT",
  });
  await expect(propose("invalid", key)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const a = await propose(t, key);
  expect(a.proposal).toMatchObject({
    event_ticker: "E",
    instrument_symbol: "GEMI-E-C",
    quantity: 2,
    quote_price: 0.39,
    limit_price: 0.4,
  });
  expect(a.proposal.readback).toContain("Buy 2 YES");
  expect((await propose(t, key)).proposal).toEqual(a.proposal);
  await expect(propose(t, key, { ...input, quantity: 1 })).rejects.toMatchObject({
    code: "KEY_REUSED",
  });
  expect(getEvent).toHaveBeenCalledTimes(1);
  expect(gPrivate).not.toHaveBeenCalled();
});

it("requires owner, spoken confirmation and enabled execution; moved asks preserve the signed resting limit", async () => {
  const t = token(),
    id = (await propose(t)).proposal.proposal_id;
  await expect(approve(token(), id)).rejects.toMatchObject({ code: "UNKNOWN_PROPOSAL" });
  await expect(approve(t, id, "maybe")).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  vi.stubEnv("EXECUTION_ENABLED", "false");
  await expect(approve(t, id)).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
  vi.stubEnv("EXECUTION_ENABLED", "true");
  quote(".44");
  vi.mocked(gPrivate).mockResolvedValueOnce({ ok:true, status:200, text:"", data:{ orderId:"2", status:"cancelled", filledQuantity:"0" } });
  expect(await approve(t, id)).toMatchObject({ ok:true, outcome_summary:"NOT_FILLED" });
  expect(gPrivate).toHaveBeenCalledWith("/v1/prediction-markets/order", expect.objectContaining({price:"0.40"}), expect.objectContaining({submitBefore:expect.any(Number)}));
});

it("releases the cancelled share of the SQLite reservation for a separately approved remainder", async () => {
  vi.stubEnv("MAX_DAILY_USD", "0.84");
  const t = token();
  const first = await propose(t);
  vi.mocked(gPrivate).mockResolvedValueOnce({ok:true,status:200,text:"",data:{
    orderId:"1",status:"cancelled",filledQuantity:"1",remainingQuantity:"0",avgExecutionPrice:".39",
  }});
  const result = await approve(t, first.proposal.proposal_id);
  quote(".45");
  const retry = await propose(t, randomUUID(), result.remainder_buy);
  expect(retry.proposal).toMatchObject({quantity:1,limit_price:.4,quote_price:.45});
  expect(gPrivate).toHaveBeenCalledTimes(1);
  await expect(approve(t, retry.proposal.proposal_id, "no")).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
  expect(gPrivate).toHaveBeenCalledTimes(1);
});

it("atomically reserves aggregate daily exposure, submits at most once and replays completed results", async () => {
  vi.stubEnv("MAX_DAILY_USD", "1.20");
  const t = token(),
    u = token(),
    a = (await propose(t)).proposal.proposal_id,
    b = (await propose(u)).proposal.proposal_id;
  const [first, duplicate, overCap] = await Promise.allSettled([
    approve(t, a),
    approve(t, a),
    approve(u, b),
  ]);
  expect(first.status).toBe("fulfilled");
  expect(duplicate).toMatchObject({ status: "rejected", reason: { code: "IN_PROGRESS" } });
  expect(overCap).toMatchObject({ status: "rejected", reason: { code: "CAP_EXCEEDED" } });
  expect(await approve(t, a)).toMatchObject({ ok: true, outcome_summary: "FILLED" });
  expect(gPrivate).toHaveBeenCalledTimes(1);
  expect(gPrivate).toHaveBeenCalledWith(
    "/v1/prediction-markets/order",
    expect.objectContaining({
      symbol: "GEMI-E-C",
      quantity: "2",
      price: "0.40",
      side: "buy",
      outcome: "yes",
      timeInForce: "good-til-cancel",
    }),
    {submitBefore:expect.any(Number)},
  );
});

it.each(["0", "1"])("rests an explicit buy limit without an ask, with %s filled and no duplicate submission", async (filled) => {
  quote("");
  const t = token();
  const { proposal } = await propose(t);
  expect(proposal).toMatchObject({ quote_price: null, limit_price: .4, time_in_force: "good-til-cancel" });
  vi.mocked(gPrivate).mockResolvedValue({
    ok: true, status: 201, text: "", data: { orderId: "open-order", status: "open",
      filledQuantity: filled, remainingQuantity: String(2 - Number(filled)) },
  });
  const result = await approve(t, proposal.proposal_id);
  expect(result).toMatchObject({ ok: true, outcome_summary: "OPEN", filled_quantity: Number(filled) });
  expect(result.remainder_buy).toBeUndefined();
  expect(result.say).toMatch(/open at 40 cents/i);
  expect(await approve(t, proposal.proposal_id)).toMatchObject({ outcome_summary: "OPEN" });
  expect(gPrivate).toHaveBeenCalledTimes(1);
  expect(repo.db.prepare("SELECT status,reserved_cents FROM browser_proposals").get()).toMatchObject({
    status: "OPEN", reserved_cents: Math.round(100 * (proposal.notional_usd + proposal.est_fee_usd)),
  });
});

it("reconciles a cancelled resting order before refusing a new proposal against the daily cap", async () => {
  vi.stubEnv("MAX_DAILY_USD", "1.30");
  const t = token();
  const id = (await propose(t)).proposal.proposal_id;
  vi.mocked(gPrivate).mockResolvedValueOnce({
    ok: true, status: 201, text: "", data: { orderId: "resting", status: "open", filledQuantity: "0", remainingQuantity: "2" },
  });
  expect(await approve(t, id)).toMatchObject({ outcome_summary: "OPEN" });
  vi.mocked(gPrivate).mockResolvedValueOnce({
    ok: true, status: 200, text: "", data: { orders: [{ orderId: "resting", symbol: input.contract_symbol,
      status: "cancelled", filledQuantity: "1", remainingQuantity: "1", avgExecutionPrice: ".39" }] },
  });
  expect((await propose(t)).ok).toBe(true);
  expect(repo.db.prepare("SELECT status,reserved_cents,approval_day FROM browser_proposals WHERE id=?").get(id))
    .toMatchObject({ status: "DONE", reserved_cents: 41, approval_day: new Date().toISOString().slice(0, 10) });
  expect(await approve(t, id)).toMatchObject({ outcome_summary: "PARTIAL", filled_quantity: 1 });
  expect(vi.mocked(gPrivate).mock.calls.filter(([path]) => path === "/v1/prediction-markets/order")).toHaveLength(1);
});

it("retains uncertain exposure and reports uncertain fills without a retry", async () => {
  const t = token(),
    id = (await propose(t)).proposal.proposal_id;
  vi.mocked(gPrivate).mockResolvedValue({
    ok: false,
    status: 0,
    data: null,
    text: "",
    timedOut: true,
  });
  expect(await approve(t, id)).toMatchObject({ outcome_summary: "PENDING_UNKNOWN" });
  expect(await approve(t, id)).toMatchObject({ outcome_summary: "PENDING_UNKNOWN" });
  expect(
    repo.db.prepare("SELECT reserved_cents FROM browser_proposals").get().reserved_cents,
  ).toBeGreaterThan(0);
  expect(gPrivate).toHaveBeenCalledTimes(1);
});

it("rejects superseded, expired and ended-session proposals", async () => {
  const t = token(),
    a = (await propose(t)).proposal.proposal_id,
    b = (await propose(t)).proposal.proposal_id;
  await expect(approve(t, a)).rejects.toMatchObject({ code: "SUPERSEDED" });
  repo.db
    .prepare(
      "UPDATE browser_proposals SET terms=json_set(terms,'$.expires_at','2000-01-01') WHERE id=?",
    )
    .run(b);
  await expect(approve(t, b)).rejects.toMatchObject({ code: "EXPIRED" });
  repo.db.exec("UPDATE sessions SET state='ended'");
  await expect(propose(t)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(gPrivate).not.toHaveBeenCalled();
});

it("keeps account reads PIN-protected, projects approved fields, and distinguishes missing rows from empty reports", async () => {
  const read = (p: string) => run({ method: "POST", path: "portfolio", body: { pin: p } });
  await expect(read("0000")).rejects.toMatchObject({ code: "WRONG_PIN" });
  expect(gPrivate).not.toHaveBeenCalled();
  vi.mocked(gPrivate)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: "",
      data: { orders: [{ orderId: "9", symbol: "C", private: "hidden" }] },
    })
    .mockResolvedValueOnce({ ok: true, status: 200, text: "", data: { positions: [] } })
    .mockResolvedValueOnce({ ok: false, status: 403, text: "", data: null });
  const a = await read(pin);
  expect(a.orders.rows).toEqual([{ orderId: "9", symbol: "C" }]);
  expect(a.positions.rows).toEqual([]);
  expect(a.history.error).toBeTruthy();
});

it("bounds a burst of independent account approvals at the configured dollar cap", async () => {
  vi.stubEnv("MAX_DAILY_USD", "2");
  const sessions = Array.from({ length: 30 }, token);
  const proposals: { proposal: { proposal_id: string } }[] = await Promise.all(
    sessions.map((t) => propose(t)),
  );
  const approvals = await Promise.allSettled(
    proposals.map((p, i) => approve(sessions[i]!, p.proposal.proposal_id)),
  );
  expect(approvals.filter((a) => a.status === "fulfilled")).toHaveLength(2);
  expect(approvals.filter((a) => a.status === "rejected")).toHaveLength(28);
  expect(gPrivate).toHaveBeenCalledTimes(2);
});

it("keeps typed order submission disabled and accepts explicit speech with no configured PIN", async () => {
  const t = token(), { proposal } = await propose(t);
  await expect(run({ method:"POST", path:"approve", token:t, body:{proposal_id:proposal.proposal_id, pin} })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(gPrivate).not.toHaveBeenCalled();
  vi.stubEnv("DEMO_PIN", "");
  expect(await approve(t, proposal.proposal_id)).toMatchObject({ok:true,outcome_summary:"FILLED"});
});

it("sizes a dollar budget in whole contracts including rounded fees and binds replay to the sizing unit", async () => {
  const { quantity: _count, ...terms } = input;
  const t = token(), key = randomUUID();
  const dollars = { ...terms, budget_usd: 1.25 };
  const r = await propose(t, key, dollars);
  expect(r.proposal).toMatchObject({ quantity: 2, limit_price: 0.4, notional_usd: 0.8, est_fee_usd: 0.04 });
  expect((await propose(t, key, dollars)).proposal).toEqual(r.proposal);
  await expect(propose(t, key, { ...terms, budget_usd: 1.26 })).rejects.toMatchObject({ code: "KEY_REUSED" });
  const equal = randomUUID();
  await propose(t, equal, { ...terms, budget_usd: 2 });
  await expect(propose(t, equal, input)).rejects.toMatchObject({ code: "KEY_REUSED" });
  expect((await propose(t, randomUUID(), { ...terms, budget_usd: 1.26 })).proposal.quantity).toBe(3);
  for (const invalid of [0, -1, 0.001, "100", null, Infinity, Number.MAX_SAFE_INTEGER]) {
    await expect(propose(t, randomUUID(), { ...terms, budget_usd: invalid })).rejects.toMatchObject({ code: "BAD_INPUT" });
  }
  await expect(propose(t, randomUUID(), { ...input, budget_usd: 100 })).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(await propose(t, randomUUID(), { ...terms, budget_usd: 0.4 })).toMatchObject({ ok: false, error: "CAP_EXCEEDED" });
});

async function paired() {
  let cookie = "";
  const host = "127.0.0.1:5173";
  await run({ path: "pair", method: "POST", body: { pin }, host,
    setDeviceCookie: (value: string) => { cookie = value; } });
  return { host, deviceCookie: cookie };
}

it("executes one local sandbox buy only after the unpaired call hears its fresh readback and confirms", async () => {
  const device = {host:"localhost:5173"};
  const t = token();
  const owner = repo.authenticate(createHash("sha256").update(t).digest("hex")).id;
  const { proposal } = await run({ ...device, token:t, method:"POST", path:"proposals", key:randomUUID(), body:input });
  expect(proposal.voice_readback).toBe("Example event, Option. Buy two yes up to forty cents. Confirm?");
  const confirm = (seq:number, credentials: Record<string,string> = device) =>
    run({ ...credentials, token:t, method:"POST", path:"voice-confirm", body:{proposal_id:proposal.proposal_id, confirmation_seq:seq} });
  const entry = (seq:number, role:string, text:string, interrupted = false, now = Date.now()) =>
    repo.append(owner, {role, seq, text, interrupted}, now);
  await expect(confirm(1)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
  entry(1,"agent",proposal.voice_readback,true);
  entry(2,"user","confirm");
  await expect(confirm(2)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
  entry(3,"agent",proposal.voice_readback.replace("forty cents","four cents"));
  entry(4,"user","yes");
  await expect(confirm(4)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
  entry(5,"agent",proposal.voice_readback);
  entry(6,"user","yes, but change that");
  await expect(confirm(6)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
  entry(7,"agent",proposal.voice_readback);
  entry(8,"user","confirm",false,Date.now()-31000);
  await expect(confirm(8)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
  entry(9,"agent","[neutral] " + proposal.voice_readback);
  entry(10,"user","Confirm.");
  expect(gPrivate).not.toHaveBeenCalled();
  const responses = await Promise.allSettled([confirm(10),confirm(10)]);
  expect(responses[0]).toMatchObject({ status:"fulfilled", value:{ok:true,outcome_summary:"FILLED"} });
  expect(responses[1]).toMatchObject({ status:"rejected",reason:{code:"IN_PROGRESS"} });
  expect(await confirm(10)).toMatchObject({ ok:true,outcome_summary:"FILLED" });
  expect(gPrivate).toHaveBeenCalledTimes(1);
});

it("opens a trusted device only with a fresh single-use local pairing code", async () => {
  // @ts-expect-error local Node module.
  const { TrustedDevices } = await import("../../../server/trusted-device.mjs");
  const devices = new TrustedDevices(repo);
  const code = devices.issueCode();
  const host = "127.0.0.1:5173";
  let deviceCookie = "";
  const pair = (value:string) => run({ path:"pair", method:"POST", host, body:{pairing_token:value},
    setDeviceCookie:(value:string) => {deviceCookie=value;} });
  await expect(pair("bogus")).rejects.toMatchObject({code:"PAIRING_EXPIRED"});
  await expect(pair(code)).resolves.toMatchObject({voice_authorized:true});
  await expect(pair(code)).rejects.toMatchObject({code:"PAIRING_EXPIRED"});
  const available = () => run({path:"availability",method:"GET",host,deviceCookie});
  expect((await available()).voice_authorized).toBe(true);
  repo.db.exec("UPDATE browser_devices SET expires=0");
  expect((await available()).voice_authorized).toBe(false);
  const expired = devices.issueCode();
  repo.db.exec("UPDATE browser_pairing_codes SET expires=0");
  await expect(pair(expired)).rejects.toMatchObject({code:"PAIRING_EXPIRED"});
});

it("requires paired device identity for private reads", async () => {
  const device = await paired();
  await expect(run({path:"portfolio",method:"POST",body:{}})).rejects.toMatchObject({code:"DEVICE_REQUIRED"});
  vi.mocked(gPrivate).mockResolvedValue({
    ok:true,status:200,text:"", data:{ orders:[], positions:[{symbol:"C",contractMetadata:{eventName:"Bitcoin today",contractName:"Up",otherPrivate:"redacted"}}] },
  });
  const portfolio = await run({...device,path:"portfolio",method:"POST",body:{}});
  expect(portfolio.positions.rows).toEqual([{symbol:"C",event_title:"Bitcoin today",contract_label:"Up"}]);
});

function nativeCombo() {
  const eventTicker = "CMB-270101-TEST";
  const symbol = "GEMI-CMB-270101-TEST-CMB";
  const expiry = new Date(Date.now()+86400000).toISOString();
  const contract = { isCombo:true, instrumentSymbol:symbol, label:"Both levels", status:"active", marketState:"open",
    expiryDate:expiry, prices:{buy:{yes:".37", no:".64"}, sell:{yes:".36",no:".63"}} };
  const event = {ticker:eventTicker,title:"Oil and Bitcoin",status:"active",contracts:[contract]};
  const meta = { contract:{instrumentSymbol:symbol,eventTicker,contractStatus:"Active",expiryDate:expiry},
    legs:[{requiredOutcome:"Yes",contract:{instrumentSymbol:"GEMI-BTC-LEVEL",contractStatus:"Active",expiryDate:expiry}},
          {requiredOutcome:"No",legOutcome:"Pass",contract:{instrumentSymbol:"GEMI-OIL-LEVEL",contractStatus:"Settled",resolutionSide:"no"}}] };
  vi.mocked(getEvent).mockResolvedValue({event});
  vi.mocked(gPublic).mockResolvedValue({ok:true,data:meta,status:200,text:""});
  return {event,contract,meta,order:{...input,event_ticker:eventTicker,contract_symbol:symbol}};
}

it("uses the verified native combo's own outcome price at proposal and approval", async () => {
  const {order} = nativeCombo();
  const t = token();
  const r = await propose(t, randomUUID(), {...order,outcome:"no",limit_price:.65});
  expect(r.proposal.quote_price).toBe(.64);
  expect(await approve(t, r.proposal.proposal_id)).toMatchObject({ok:true,outcome_summary:"FILLED"});
  expect(gPublic).toHaveBeenCalledTimes(2);
  expect(gPublic).toHaveBeenCalledWith("/v1/prediction-markets/combos/" + order.contract_symbol);
  expect(gPrivate).toHaveBeenCalledTimes(1);
  expect(gPrivate).toHaveBeenCalledWith("/v1/prediction-markets/order",
    expect.objectContaining({symbol:order.contract_symbol,side:"buy",outcome:"no",price:"0.65"}), {submitBefore:expect.any(Number)});
});

it("verifies native combo eligibility and preserves the signed limit when quotes change", async () => {
  const t = token();
  const {event,order,contract,meta} = nativeCombo();
  const produce = () => propose(t,randomUUID(),order);
  const proposal = (await produce()).proposal;
  meta.legs[1]!.legOutcome = "Fail";
  expect(await approve(t, proposal.proposal_id)).toMatchObject({ok:false,error:"COMBO_UNAVAILABLE"});
  meta.legs[1]!.legOutcome = "Pass";
  meta.contract.instrumentSymbol += "-WRONG";
  expect(await produce()).toMatchObject({ok:false,error:"COMBO_UNAVAILABLE"});
  meta.contract.instrumentSymbol = order.contract_symbol;
  meta.legs[0]!.contract.expiryDate = "2000-01-01T00:00:00Z";
  expect(await produce()).toMatchObject({ok:false,error:"COMBO_UNAVAILABLE"});
  meta.legs[0]!.contract.expiryDate = contract.expiryDate;
  contract.prices.buy.yes = "";
  expect(await produce()).toMatchObject({ok:false,error:"NO_LIQUIDITY"});
  contract.prices.buy.yes = ".37";
  const another = (await produce()).proposal;
  contract.prices.buy.yes = ".84";
  vi.mocked(gPrivate).mockResolvedValueOnce({ ok:true, status:200, text:"", data:{orderId:"2",status:"cancelled",filledQuantity:"0"} });
  expect(await approve(t,another.proposal_id)).toMatchObject({ok:true,outcome_summary:"NOT_FILLED"});
  event.status = "settled";
  expect(await produce()).toMatchObject({ok:false,error:"COMBO_UNAVAILABLE"});
  expect(gPrivate).toHaveBeenCalledTimes(1);
});

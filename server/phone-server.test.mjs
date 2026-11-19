import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import twilio from "twilio";
import "tsx/esm";
import { SQLiteRepository } from "./repository.mjs";
import { PhoneStore } from "./phone-store.mjs";
const { createPhoneServer } = await import("./phone-server.mjs");

test("signed inbound callbacks authenticate once, persist turns and share the sandbox spend ledger", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-fixture-"));
  let repo, server, origin;
  const config = {
    origin: "https://voice.example.test",
    token: "fixture-token",
    account: "AC" + "a".repeat(32),
    from: "+12025550101",
    to: "+12025550102",
  };
  const sid = "CA" + "c".repeat(32);
  const form = {
    CallSid: sid,
    AccountSid: config.account,
    From: config.from,
    To: config.to,
    Direction: "inbound",
    CallStatus: "in-progress",
  };
  const http = globalThis.fetch;
  const orders = [];
  let delayOrder;
  const seen = [];
  const expiryDate = new Date(Date.now() + 3600000).toISOString();
  const event = {
    ticker: "BTC05M1234567890",
    title: "Bitcoin direction",
    contracts: [
      {
        instrumentSymbol: "GEMI-BTC05M1234567890-UP",
        label: "Up",
        status: "active",
        marketState: "open",
        expiryDate,
        prices: { buy: { yes: 0.4, no: 0.6 } },
      },
    ],
  };
  Object.assign(process.env, {
    GEMINI_HOST: "https://api.sandbox.gemini.com",
    GEMINI_API_BASE_URL: "https://api.sandbox.gemini.com",
    GEMINI_API_KEY: "fixture-key",
    GEMINI_API_SECRET: "fixture-secret",
    EXECUTION_ENABLED: "true",
    MAX_DAILY_USD: "12",
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.origin, "https://api.sandbox.gemini.com");
    const path = url.pathname.split("/").at(-1);
    seen.push(path);
    if (path === "events") return Response.json({ data: [event] });
    if (path === event.ticker) return Response.json(event);
    if (path === "positions")
      return Response.json({
        positions: [{ outcome: "yes", totalQuantity: "23", symbol: "GEMI-PRIVATE-ID" }],
      });
    if (path === "order") {
      const fields = JSON.parse(Buffer.from(init.headers["X-GEMINI-PAYLOAD"], "base64").toString());
      orders.push(fields);
      if (delayOrder) {
        await delayOrder;
        return Response.json({}, { status: 503 });
      }
      return Response.json({
        filledQuantity: fields.quantity,
        avgExecutionPrice: 0.4,
        orderId: "fixture-order",
      });
    }
    throw Error("Unexpected request");
  });
  async function start() {
    repo = new SQLiteRepository(join(dir, "ledger.sqlite"));
    server = createPhoneServer(repo, config);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = "http://127.0.0.1:" + server.address().port;
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    repo.close();
  }
  await start();
  t.after(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function post(path, extra = {}, signedOrigin = config.origin) {
    const fields = { ...form, ...extra };
    const signature = twilio.getExpectedTwilioSignature(config.token, signedOrigin + path, fields);
    const res = await http(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
        "x-forwarded-host": "untrusted.example",
      },
      body: new URLSearchParams(fields),
    });
    return { status: res.status, xml: await res.text() };
  }
  const next = (xml) => new URL(/action="([^"]+)"/.exec(xml)[1]).pathname;
  const incoming = "/phone/incoming";
  assert.equal((await post(incoming, {}, origin)).status, 403);
  for (const extra of [
    { AccountSid: "AC" + "b".repeat(32) },
    { From: "+12025550103" },
    { To: "+12025550104" },
    { Direction: "outbound-api" },
  ])
    assert.equal((await post(incoming, extra)).status, 403);
  assert.equal((await post("/api/trading/approve")).status, 404);
  const code = new PhoneStore(repo, config).issueCode();
  const first = (await post(incoming)).xml;
  assert.match(first, /input="dtmf"/);
  assert.equal((await post(incoming)).xml, first);
  const other = { CallSid: "CA" + "d".repeat(32) };
  const otherTurn = next((await post(incoming, other)).xml);
  assert.match(
    (await post(otherTurn, { ...other, SpeechResult: "positions" })).xml,
    /Pairing failed/,
  );
  let xml = (await post(next(first), { Digits: code })).xml;
  assert.match(xml, /Paired/);
  const reuser = { CallSid: "CA" + "e".repeat(32) };
  assert.match(
    (await post(next((await post(incoming, reuser)).xml), { ...reuser, Digits: code })).xml,
    /Pairing failed/,
  );
  assert.equal(seen.length, 0);
  async function say(text) {
    xml = (await post(next(xml), { SpeechResult: text })).xml;
  }
  async function quote() {
    await say("Bitcoin up in five minutes");
    assert.match(xml, /Bitcoin direction/);
    await say("option one");
    assert.match(xml, /40 cents/);
    await say("buy ten dollars of yes");
    assert.match(xml, /Buy 23 YES.*41 cents.*9.82 dollars.*<\/Say><Gather/);
  }
  await quote();
  const canceled = next(xml);
  await say("confirm later");
  assert.match(xml, /Order canceled/);
  assert.doesNotMatch((await post(canceled, { SpeechResult: "confirm" })).xml, /Filled/);
  assert.equal(orders.length, 0);
  await quote();
  process.env.EXECUTION_ENABLED = "false";
  await say("confirm");
  assert.match(xml, /execution is unavailable/);
  assert.equal(orders.length, 0);
  process.env.EXECUTION_ENABLED = "true";
  await quote();
  const confirm = next(xml);
  await stop();
  await start();
  const [a, b] = await Promise.all([
    post(confirm, { SpeechResult: "confirm", proposal_id: "untrusted" }),
    post(confirm, { SpeechResult: "confirm" }),
  ]);
  xml = (await post(confirm, { SpeechResult: "confirm" })).xml;
  assert.match(xml, /Filled 23 sandbox contracts/);
  assert.ok([a, b].every((r) => r.xml === xml || r.xml.includes("<Redirect")));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].timeInForce, "immediate-or-cancel");
  assert.equal(orders[0].symbol, event.contracts[0].instrumentSymbol);
  assert.equal(orders[0].price, "0.41");
  assert.equal(orders[0].quantity, "23");
  const row = repo.db
    .prepare("SELECT owner,status,reserved_cents FROM browser_proposals WHERE status='DONE'")
    .get();
  assert.equal(row.owner, "phone:" + sid);
  assert.equal(row.status, "DONE");
  assert.equal(row.reserved_cents, 982);
  await say("positions");
  assert.match(xml, /23 yes/);
  assert.doesNotMatch(xml, /GEMI-PRIVATE/);
  // A proposal claimed by the browser consumes the very same account-wide allowance.
  const { TradingRepository } = await import("./trading-repository.mjs");
  const browser = new TradingRepository(repo);
  const terms = {
    ...JSON.parse(
      repo.db.prepare("SELECT terms FROM browser_proposals WHERE status='DONE'").get().terms,
    ),
    quantity: 1,
    notional_usd: 0.41,
    est_fee_usd: 0.02,
  };
  const proposal = browser.propose(
    "browser-session",
    "browser-key",
    "browser-fingerprint",
    terms,
    12,
  );
  browser.claim("browser-session", proposal.proposal_id, {
    maxQuantity: 100,
    maxLimitPrice: 0.95,
    maxOrderUsd: 25,
    maxDailyUsd: 12,
  });
  await say("pull up Bitcoin");
  await say("one");
  await say("buy yes");
  await say("five contracts");
  assert.match(xml, /exceeds your sandbox spend limit/);
  assert.equal(orders.length, 1);
  const third = { CallSid: "CA" + "f".repeat(32) };
  const login = next((await post(incoming, third)).xml);
  const thirdCode = new PhoneStore(repo, config).issueCode();
  const active = next((await post(login, { ...third, Digits: thirdCode })).xml);
  async function thirdSay(path, speech) {
    return (await post(path, { ...third, SpeechResult: speech })).xml;
  }
  let thirdXml = await thirdSay(active, "Bitcoin up in five minutes");
  thirdXml = await thirdSay(next(thirdXml), "option one");
  thirdXml = await thirdSay(next(thirdXml), "buy one contract of yes");
  const approve = next(thirdXml);
  let releaseOrder;
  delayOrder = new Promise((resolve) => {
    releaseOrder = resolve;
  });
  const pending = await thirdSay(approve, "confirm");
  const poll = new URL(/<Redirect[^>]*>([^<]+)<\/Redirect>/.exec(pending)[1]).pathname;
  assert.match(poll, /^\/phone\/result\//);
  assert.match((await post(poll, third)).xml, /<Redirect/);
  assert.doesNotMatch((await post(poll)).xml, /<Redirect/);
  releaseOrder();
  for (let i = 0; i < 30; i++) {
    thirdXml = (await post(poll, third)).xml;
    if (!thirdXml.includes("<Redirect")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(thirdXml, /has not confirmed the result/);
  assert.equal(await thirdSay(approve, "confirm"), thirdXml);
  assert.equal(
    repo.db.prepare("SELECT reserved_cents FROM browser_proposals WHERE status='UNKNOWN'").get()
      .reserved_cents,
    43,
  );
  assert.match(await thirdSay(next(thirdXml), "done"), /Goodbye.*Hangup/);
  assert.equal((await post("/phone/status", { CallStatus: "completed" })).status, 204);
  assert.doesNotMatch((await post(incoming)).xml, /Gather/);
  assert.doesNotMatch((await post(confirm, { SpeechResult: "confirm" })).xml, /Filled/);
  assert.equal(orders.length, 2);
});

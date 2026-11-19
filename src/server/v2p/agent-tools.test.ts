// @vitest-environment node
// The phone/webhook tools must never be able to submit an order.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ db: { from: vi.fn() }, executionEnabled: vi.fn(async () => true), logActivity: vi.fn(async () => {}) }));
vi.mock("./receipts", () => ({ createReceipt: vi.fn() }));
vi.mock("./gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gemini")>()),
  gPrivate: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock("./ledger", async (original) => ({ ...(await original<typeof import("./ledger")>()), supabaseLedger: { committedUsd: async () => 0 } }));

import { db } from "./db";
import { getEvent, gPrivate } from "./gemini";
import { handleAgentTools } from "./agent-tools";

const SECRET = "tool-secret-0123456789abcdefXYZ";
const call = (tool: string, body: object, headers: Record<string, string> = { "x-tool-secret": SECRET }) =>
  handleAgentTools(new Request(`https://x.test/api/public/agent-tools/${tool}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.stubEnv("TOOL_SHARED_SECRET", SECRET);
  vi.stubEnv("EXECUTION_ENABLED", "true");
  vi.stubEnv("DEMO_PIN", "1234");
});
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(gPrivate).mockReset(); });

it("refuses execute_trade even with the tool secret, a valid-looking intent and the right PIN", async () => {
  const res = await call("execute_trade", { intent_code: "ABC234", pin: "1234", caller: "+15551234567", conversation_id: "conv_1" });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ ok: false, error: "APPROVAL_REQUIRED" });
  expect(gPrivate).not.toHaveBeenCalled();
});

it("still requires the header secret (query-string secrets are ignored)", async () => {
  const res = await handleAgentTools(new Request(`https://x.test/api/public/agent-tools/find_market?s=${SECRET}`, {
    method: "POST", body: JSON.stringify({ query: "btc" }),
  }));
  expect(res.status).toBe(401);
});

it("keeps exact identifiers in the saved proposal and out of the spoken readback", async () => {
  const symbol = "GEMI-BTC05M2611190950-UP";
  const ticker = "BTC05M2611190950";
  vi.mocked(getEvent).mockResolvedValue({ event: { title: ticker, ticker, contracts: [{
    instrumentSymbol: symbol, status: "active", marketState: "open",
    expiryDate: new Date(Date.now() + 3600000).toISOString(), prices: { buy: { yes: ".40" } },
  }] } });
  const insert = vi.fn(async () => ({ error: null }));
  vi.mocked(db.from).mockReturnValue({
    update: () => ({ eq: () => ({ eq: async () => ({error: null}) }) }), insert,
  } as unknown as ReturnType<typeof db.from>);
  const res = await call("prepare_trade", {
    event_ticker: ticker, instrument_symbol: symbol, outcome: "yes", side: "buy", quantity: 1,
  });
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, readback: "Review the proposal on your dashboard." });
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ instrument_symbol: symbol, event_ticker: ticker }));
});

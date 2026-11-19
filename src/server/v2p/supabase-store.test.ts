// @vitest-environment node
// Checks the real Supabase-backed store and ledger queries against a recording fake of supabase-js.
import { beforeEach, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };
const queue: Record<string, Result[]> = {};
const calls: Record<string, unknown[][]> = {};
function builder(table: string): any {
  const result = queue[table]?.shift() ?? { data: [], error: null };
  const log = (calls[table] ??= []);
  const b: any = {};
  for (const m of ["select", "eq", "or", "gte", "gt", "lte", "in", "order", "limit", "update", "insert", "upsert"]) {
    b[m] = (...args: unknown[]) => { log.push([m, ...args]); return b; };
  }
  b.maybeSingle = () => Promise.resolve(result);
  b.single = () => Promise.resolve(result);
  b.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
  return b;
}
vi.mock("./db", () => ({
  db: { from: (t: string) => builder(t) },
  executionEnabled: vi.fn(async () => true),
  logActivity: vi.fn(async () => {}),
}));
vi.mock("./receipts", () => ({ createReceipt: vi.fn() }));

import { supabaseStore } from "./browser-trading";
import { dailyCapError, orderCapError, supabaseLedger } from "./ledger";

beforeEach(() => {
  for (const k of Object.keys(queue)) delete queue[k];
  for (const k of Object.keys(calls)) delete calls[k];
});

it("claim only matches this session's unexpired PROPOSED buy and flips it to EXECUTING", async () => {
  queue["intents"] = [{ data: [{ id: "i1", caller: "session:abc" }], error: null }];
  const it1 = await supabaseStore().claim("i1", "session:abc");
  expect(it1).toMatchObject({ id: "i1" });
  const c = calls["intents"] ?? [];
  expect(c).toContainEqual(["update", expect.objectContaining({ status: "EXECUTING" })]);
  expect(c).toContainEqual(["eq", "id", "i1"]);
  expect(c).toContainEqual(["eq", "caller", "session:abc"]);
  expect(c).toContainEqual(["eq", "status", "PROPOSED"]);
  expect(c).toContainEqual(["eq", "side", "buy"]);
  expect(c.some(([m, col]) => m === "gt" && col === "expires_at")).toBe(true);
});

it("claim returns null when nothing (or more than one row) matched", async () => {
  queue["intents"] = [{ data: [], error: null }];
  expect(await supabaseStore().claim("i1", "session:abc")).toBeNull();
});

it("ledger sums filled buys, reserves unknown outcomes and in-flight approvals", async () => {
  queue["orders"] = [{ data: [
    { intent_id: "a", outcome_summary: "FILLED", filled_notional_usd: 1.5 },
    { intent_id: "b", outcome_summary: "NOT_FILLED", filled_notional_usd: 0 },
    { intent_id: "c", outcome_summary: "PENDING_UNKNOWN", filled_notional_usd: 0 },
  ], error: null }];
  queue["intents"] = [
    { data: [{ id: "x", notional_usd: 2, est_fee_usd: 0.1 }, { id: "c", notional_usd: 3, est_fee_usd: 0.2 }, { id: "self", notional_usd: 9, est_fee_usd: 1 }], error: null }, // EXECUTING
    { data: [{ id: "c", notional_usd: 3, est_fee_usd: 0.2 }], error: null }, // PENDING_UNKNOWN lookup
  ];
  expect(await supabaseLedger.committedUsd({ excludeIntentId: "self" })).toBe(6.8);
  expect(calls["orders"]).toContainEqual(["eq", "side", "buy"]);
  expect(calls["orders"]).toContainEqual(["or", expect.stringContaining(",outcome_summary.eq.PENDING_UNKNOWN")]);
  expect(calls["intents"]).toContainEqual(["eq", "status", "EXECUTING"]);
});

it("ledger fails closed when it cannot be read", async () => {
  queue["orders"] = [{ data: null, error: { message: "down" } }];
  expect(await supabaseLedger.committedUsd()).toBeNull();
});

it("cap helpers use the configured limits", () => {
  vi.stubEnv("MAX_DAILY_USD", "50");
  vi.stubEnv("MAX_ORDER_USD", "25");
  expect(dailyCapError(49.5, 0.4)).toBeNull();
  expect(dailyCapError(49.5, 0.6)).toMatch(/Daily sandbox limit/);
  expect(orderCapError({ quantity: 1, limit_price: 0.31, notional_usd: 0.31, est_fee_usd: 0.02 })).toBeNull();
  expect(orderCapError({ quantity: 1, limit_price: 0.99, notional_usd: 0.99, est_fee_usd: 0.01 })).toMatch(/Limit price/);
  expect(orderCapError({ quantity: 101, limit_price: 0.1, notional_usd: 10.1, est_fee_usd: 0.7 })).toMatch(/contracts/);
  vi.unstubAllEnvs();
});

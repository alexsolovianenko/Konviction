// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
// @ts-expect-error JavaScript repository is used by the local Node service.
import { SQLiteRepository } from "../../../server/repository.mjs";
// @ts-expect-error JavaScript service is used by the local Node launcher.
import { browserTrading } from "../../../server/browser-trading.mjs";
import { getEvent, gPrivate } from "./gemini";

vi.mock("./gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gemini")>()),
  getEvent: vi.fn(),
  gPrivate: vi.fn(),
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
const approve = (t: string, id: string, p = pin) =>
  run({ method: "POST", path: "approve", token: t, body: { proposal_id: id, pin: p } });
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

it("requires owner, separate PIN and enabled execution; moved prices never submit", async () => {
  const t = token(),
    id = (await propose(t)).proposal.proposal_id;
  await expect(approve(token(), id)).rejects.toMatchObject({ code: "UNKNOWN_PROPOSAL" });
  await expect(approve(t, id, "0000")).rejects.toMatchObject({ code: "WRONG_PIN" });
  vi.stubEnv("EXECUTION_ENABLED", "false");
  await expect(approve(t, id)).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
  vi.stubEnv("EXECUTION_ENABLED", "true");
  quote(".44");
  expect(await approve(t, id)).toMatchObject({ ok: false, error: "PRICE_MOVED" });
  expect(gPrivate).not.toHaveBeenCalled();
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
      timeInForce: "immediate-or-cancel",
    }),
  );
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
  await expect(approve(t, a)).rejects.toMatchObject({ code: "INACTIVE" });
  repo.db
    .prepare(
      "UPDATE browser_proposals SET terms=json_set(terms,'$.expires_at','2000-01-01') WHERE id=?",
    )
    .run(b);
  await expect(approve(t, b)).rejects.toMatchObject({ code: "INACTIVE" });
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

it("locks repeated incorrect PINs across sessions and disables approval without a configured PIN", async () => {
  const t = token(),
    id = (await propose(t)).proposal.proposal_id;
  for (let i = 0; i < 3; i++)
    await expect(approve(t, id, "0000")).rejects.toMatchObject({ code: "WRONG_PIN" });
  await expect(approve(t, id)).rejects.toMatchObject({ code: "LOCKED" });
  vi.stubEnv("DEMO_PIN", "");
  await expect(approve(t, id)).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
  expect(gPrivate).not.toHaveBeenCalled();
});

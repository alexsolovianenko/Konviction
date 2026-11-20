// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { accounts, verifyCode, phoneAccount, type PhoneAccount } from "./accounts";
import { notify, settlement } from "./settlements";
import { confirmedInCall } from "../call-confirmation";

const user: PhoneAccount = {
  id: "user-1",
  phone: "+14165550123",
  apiKey: "sandbox-test-key",
  apiSecret: "sandbox-test-secret",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  notifySince: "2026-01-01T00:00:00Z",
};
const row = {
  instrumentSymbol: "TEST",
  settledAt: "2026-02-01T00:00:00Z",
  outcome: "no",
  resolutionSide: "yes",
  netProfit: "-2.30",
};
afterEach(() => vi.unstubAllEnvs());

it("accepts a Canadian E.164 registration and rejects duplicate or shared credentials", () => {
  vi.stubEnv("PHONE_ACCOUNTS_JSON", JSON.stringify([user]));
  expect(accounts()).toEqual([user]);
  vi.stubEnv("GEMINI_API_KEY", user.apiKey);
  expect(() => accounts()).toThrow();
  vi.stubEnv("GEMINI_API_KEY", "different");
  vi.stubEnv("PHONE_ACCOUNTS_JSON", JSON.stringify([user, { ...user, id: "other" }]));
  expect(() => accounts()).toThrow();
});
it("validates the six-digit RFC 6238 test vector and rejects expired codes", () => {
  expect(verifyCode(user.totpSecret, "287082", 59000)).toBe(1);
  expect(verifyCode(user.totpSecret, "287082", 150000)).toBeNull();
});
it("keeps concurrent account contexts isolated", async () => {
  const get = async () => {
    await Promise.resolve();
    return phoneAccount.getStore()?.id;
  };
  expect(
    await Promise.all([
      phoneAccount.run(user, get),
      phoneAccount.run({ ...user, id: "two" }, get),
      get(),
    ]),
  ).toEqual(["user-1", "two", undefined]);
});
it("claims one outbound call per settlement even across a provider timeout and repeated polling", async () => {
  const records = new Map<string, unknown>();
  const reserve = async (k: string, v: unknown) => {
    if (records.has(k)) return false;
    records.set(k, v);
    return true;
  };
  const dial = vi.fn(async () => {
    throw Error("timeout");
  });
  await Promise.allSettled([notify(user, row, reserve, dial), notify(user, row, reserve, dial)]);
  await notify(user, row, reserve, dial);
  expect(dial).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(dial.mock.calls)).not.toContain("-2.30");
  expect([...records.values()][0]).toMatchObject({ result: "loss", realized_pnl_usd: "-2.30" });
});
it("requires reported P&L, final resolution and settlement after opt-in", () => {
  expect(settlement({ ...row, netProfit: null }, 0)).toBeNull();
  expect(settlement({ ...row, resolutionSide: "pending" }, 0)).toBeNull();
  expect(settlement(row, Date.now())).toBeNull();
  expect(settlement({ ...row, outcome: "yes", netProfit: "1.25" }, 0)?.report.result).toBe("win");
});
it("rejects telephone confirmation without the bound preparation and spoken readback", () => {
  expect(
    confirmedInCall(JSON.stringify({ entries: [{ role: "user", message: "yes" }] }), {
      toolNames: ["phone_prepare_trade"],
      idField: "proposal_id",
      id: "test",
      readback: "Buy now?",
    }),
  ).toBe(false);
});

import { afterEach, expect, it, vi } from "vitest";
import { blobStore } from "./blob-ledger";
import { SESSION_PREFIX } from "./browser-session";

type IO = NonNullable<Parameters<typeof blobStore>[0]>;
function memoryBackend() {
  let snapshot: Awaited<ReturnType<IO["read"]>> = null;
  let revision = 0;
  return {
    read: async () => structuredClone(snapshot),
    write: vi.fn<IO["write"]>(async (state, etag) => {
      if (etag !== snapshot?.etag) return false;
      snapshot = { state: structuredClone(state), etag: String(++revision) };
      return true;
    }),
  };
}
const proposal = (caller: string) => ({
  caller, side: "buy", quantity: 40, limit_price: 0.5, notional_usd: 20, est_fee_usd: 0.1,
  expires_at: new Date(Date.now() + 60000).toISOString(),
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("claims independent sandbox orders across workers and prevents duplicate claims", async () => {
  vi.stubEnv("MAX_DAILY_USD", "30");
  const io = memoryBackend();
  const a = blobStore(io), b = blobStore(io);
  await Promise.all([a.createSession("a"), b.createSession("b")]);
  const ca = SESSION_PREFIX + "a", cb = SESSION_PREFIX + "b";
  const [first, second] = await Promise.all([a.insertIntent(proposal(ca)), b.insertIntent(proposal(cb))]);
  const attempts = await Promise.allSettled([a.claim(first, ca), b.claim(second, cb)]);
  expect(attempts.map(r => r.status)).toEqual(["fulfilled","fulfilled"]);
  expect(await a.claim(first,ca)).toBeNull();
  expect(await b.claim(second,cb)).toBeNull();
  expect(await b.committedUsd()).toBe(40.2);
});

it.each(["OPEN", "PENDING_UNKNOWN"])("keeps %s and unsaved exchange results reserved across UTC rollover", async (summary) => {
  const clock = vi.spyOn(Date, "now");
  const io = memoryBackend();
  const store = blobStore(io);
  await store.createSession("test");
  const caller = SESSION_PREFIX + "test";
  const first = await store.insertIntent(proposal(caller));
  await store.claim(first, caller);
  io.write.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(store.saveOrder({intent_id:first, outcome_summary:"FILLED", filled_notional_usd:20})).rejects.toThrow();
  const second = await store.insertIntent(proposal(caller));
  await store.claim(second, caller);
  await store.saveOrder({intent_id:second, outcome_summary:summary, filled_notional_usd:0});
  await store.setIntentStatus(second, "DONE");
  clock.mockReturnValue(Date.now() + 3 * 86400000);
  await store.createSession("nextday");
  expect(await store.committedUsd()).toBe(40.2);
});

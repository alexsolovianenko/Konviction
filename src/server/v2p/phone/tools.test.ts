// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { phoneTool } from "./tools";
import { nativeCall } from "./provider";
import { runBrowserTrading } from "../browser-trading";
import { phoneAccount } from "./accounts";

vi.mock("../quicknode-research/handler", () => ({ handleQuicknodeResearch: vi.fn() }));
import { handleQuicknodeResearch } from "../quicknode-research/handler";
import { verifySessionToken } from "../browser-session";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./store", () => ({
  read: async (k: string) => state.get(k) ?? null,
  claim: async (k: string, v: unknown) => {
    if (state.has(k)) return false;
    state.set(k, v);
    return true;
  },
}));
vi.mock("./provider", () => ({ nativeCall: vi.fn() }));
vi.mock("../blob-ledger", () => ({ blobStore: () => ({ createSession: vi.fn() }) }));
vi.mock("../browser-trading", () => ({
  TradeError: class extends Error {},
  runBrowserTrading: vi.fn(),
}));
const number = "+14165550123",
  cid = "conv_test",
  code = "287082";
const owner = {
  id: "a",
  phone: number,
  apiKey: "private-A",
  apiSecret: "secret-A",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};
const invoke = (action: string, body: Record<string, unknown> = {}, secret = "test-hook") =>
  phoneTool(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { "x-call-secret": secret },
      body: JSON.stringify({ conversation_id: cid, is_text_only: false, ...body }),
    }),
    action,
  );
beforeEach(() => {
  state.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(59000);
  vi.stubEnv("PHONE_ACCOUNTS_JSON", JSON.stringify([owner]));
  vi.stubEnv("ELEVENLABS_CALL_CONFIRM_SECRET", "test-hook");
  vi.stubEnv("VOICE_SESSION_SECRET", "x".repeat(32));
  vi.mocked(nativeCall).mockResolvedValue({ phone: number, direction: "inbound", notice: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("rejects anonymous, web, text-only and unregistered calls before private tools", async () => {
  expect((await invoke("positions", {}, "")).status).toBe(403);
  expect((await invoke("positions", { is_text_only: true })).status).toBe(403);
  vi.mocked(nativeCall).mockResolvedValueOnce(null);
  expect((await invoke("positions")).status).toBe(403);
  vi.mocked(nativeCall).mockResolvedValueOnce({
    phone: "+15145550111",
    direction: "inbound",
    notice: null,
  });
  expect(await (await invoke("authenticate", { code, phone: number })).json()).toMatchObject({ok:false});
  expect(runBrowserTrading).not.toHaveBeenCalled();
});
it("binds positions and preparation to an authenticated caller and conversation, and refuses OTP reuse", async () => {
  expect(await (await invoke("positions")).json()).toMatchObject({ok:false,next_action:"phone_authenticate"});
  expect((await invoke("authenticate", { code })).status).toBe(200);
  vi.mocked(runBrowserTrading).mockImplementation(async ({ action }) =>
    action === "portfolio"
      ? { ok: true, owner: phoneAccount.getStore()?.id }
      : { ok: true, proposal: { proposal_id: "p", voice_readback: "Read back the order." } },
  );
  expect(await (await invoke("positions")).json()).toMatchObject({ owner: "a" });
  expect(await (await invoke("prepare")).json()).toMatchObject({
    proposal_id: "p",
    say: "Read back the order.",
  });
  expect(await (await invoke("positions", { conversation_id: "conv_other" })).json()).toMatchObject({ok:false,next_action:"phone_authenticate"});
  expect((await invoke("authenticate", { conversation_id: "conv_other", code })).status).toBe(403);
});
it("reveals the reserved settlement only after outbound authentication and refuses outbound orders", async () => {
  const id = "a".repeat(64);
  state.set("accounts/a/notifications/" + id, { result: "win", realized_pnl_usd: "2.30" });
  vi.mocked(nativeCall).mockResolvedValue({ phone: number, direction: "outbound", notice: id });
  expect((await invoke("authenticate", { code: "000000" })).status).toBe(403);
  expect(await (await invoke("authenticate", { code })).json()).toMatchObject({
    settlement: { result: "win", realized_pnl_usd: "2.30" },
  });
  expect((await invoke("confirm")).status).toBe(403);
});

it("binds free quotes and approved research to the same verified inbound call", async () => {
  const calls: { route: string; sid: string | undefined; owner: string | undefined }[] = [];
  vi.mocked(handleQuicknodeResearch).mockImplementation(async (req, route) => {
    const token = req.headers.get("x-trade-session-token") ?? req.headers.get("authorization")?.slice(7);
    const session = await verifySessionToken(token);
    expect(session?.cid).toBe(cid);
    calls.push({ route, sid: session?.sid, owner: phoneAccount.getStore()?.id });
    return Response.json({ ok: true, quote_id: "q", say: "Research result" });
  });
  expect((await (await invoke("research-quote")).json()).quote_id).toBe("q");
  expect((await (await invoke("research-confirm")).json()).next_action).toBe("phone_authenticate");
  await invoke("authenticate", { code });
  await invoke("research-confirm", { quote_id: "q" });
  expect(calls).toEqual([
    { route: "quote", sid: expect.any(String), owner: undefined },
    { route: "call-confirm", sid: calls[0]!.sid, owner: owner.id },
  ]);
});

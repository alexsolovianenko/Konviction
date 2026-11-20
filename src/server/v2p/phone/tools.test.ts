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
  cid = "conv_test";
const owner = {
  id: "a",
  phone: number,
  apiKey: "private-A",
  apiSecret: "secret-A",
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
  vi.stubEnv("PHONE_DEMO_GEMINI_API_KEY", "demo-test");
  vi.stubEnv("PHONE_DEMO_GEMINI_API_SECRET", "demo-secret");
  vi.stubEnv("PHONE_SANDBOX_ACCOUNT", "phone-demo");
  vi.stubEnv("PHONE_ACCOUNTS_JSON", JSON.stringify([owner]));
  vi.stubEnv("ELEVENLABS_CALL_CONFIRM_SECRET", "test-hook");
  vi.stubEnv("VOICE_SESSION_SECRET", "x".repeat(32));
  vi.mocked(nativeCall).mockResolvedValue({ phone: number, direction: "inbound", notice: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("requires a trusted native voice call and rejects legacy login requests", async () => {
  expect((await invoke("positions", {}, "")).status).toBe(403);
  expect((await invoke("positions", { is_text_only: true })).status).toBe(403);
  vi.mocked(nativeCall).mockResolvedValueOnce(null);
  expect((await invoke("positions")).status).toBe(403);
  expect((await invoke("authenticate")).status).toBe(404);
  expect(runBrowserTrading).not.toHaveBeenCalled();
});
it("immediately opens isolated demo sessions without reading personal account enrollment", async () => {
  vi.stubEnv("PHONE_ACCOUNTS_JSON", "invalid");
  vi.mocked(runBrowserTrading).mockImplementation(async ({token}) => ({
    ok: true, owner: phoneAccount.getStore()?.id, sid: (await verifySessionToken(token))?.sid,
  }));
  const first = await (await invoke("positions")).json();
  expect(first).toMatchObject({ok:true, owner:"_phone-demo", sid: expect.any(String)});
  expect(await (await invoke("prepare")).json()).toMatchObject({sid:first.sid});
  expect((await (await invoke("positions", {conversation_id:"conv_other"})).json()).sid).not.toBe(first.sid);
});
it("reads only a settlement reserved for this outbound call", async () => {
  const id = "a".repeat(64);
  const path = "accounts/a/notifications/" + id;
  state.set(path, { result: "win" });
  vi.mocked(nativeCall).mockResolvedValue({phone:number, direction:"outbound", notice:id});
  expect((await invoke("settlement")).status).toBe(403);
  state.set(path + "/accepted", {conversation_id:cid});
  expect(await (await invoke("settlement")).json()).toMatchObject({settlement:{result:"win"}});
  expect((await invoke("confirm")).status).toBe(403);
});
it("uses website demo keys only when the operator selects that account", async () => {
  vi.stubEnv("PHONE_DEMO_GEMINI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "public-sandbox-key");
  vi.stubEnv("GEMINI_API_SECRET", "public-sandbox-secret");
  expect(await (await invoke("prepare")).json()).toMatchObject({error:"PHONE_DEMO_UNAVAILABLE"});
  vi.stubEnv("PHONE_SANDBOX_ACCOUNT", "website-demo");
  vi.mocked(runBrowserTrading).mockImplementation(async () => ({ok:true,owner:phoneAccount.getStore()?.id}));
  expect(await (await invoke("positions")).json()).toMatchObject({owner:"_website-demo"});
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
  await invoke("research-confirm", { quote_id: "q" });
  expect(calls).toEqual([
    { route: "quote", sid: expect.any(String), owner: undefined },
    { route: "call-confirm", sid: calls[0]!.sid, owner: undefined },
  ]);
});

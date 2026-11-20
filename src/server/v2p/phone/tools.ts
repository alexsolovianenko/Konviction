import { accounts, digest, phoneAccount, phoneDemoAccount } from "./accounts";
import { nativeCall } from "./provider";
import { claim, read } from "./store";
import { blobStore } from "../blob-ledger";
import { runBrowserTrading, TradeError } from "../browser-trading";
import { mintSessionToken, SESSION_TTL_MS, type SessionClaims } from "../browser-session";
import { secretEqual } from "../util";

export async function phoneTool(req: Request, action: string) {
  const reply = (status: number, value: unknown) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const denied = () =>
    reply(403, { ok: false, say: "Account access is unavailable for this call." });
  const secret = req.headers.get("x-call-secret") || "";
  if (!(await secretEqual(secret, process.env["ELEVENLABS_CALL_CONFIRM_SECRET"] || "")))
    return denied();
  try {
    const b = await req.json();
    const { conversation_id: cid, history, is_text_only, ...terms } = b;
    if (typeof cid !== "string" || is_text_only !== false) return denied();
    const call = await nativeCall(cid);
    if (!call) return denied();
    // Public research quotes need no private Gemini account. Bind them to this verified call.
    async function research(route: "quote" | "status" | "call-confirm") {
      const { handleQuicknodeResearch } = await import("../quicknode-research/handler");
      const hex = digest("phone-research:" + cid).slice(0, 32);
      const sid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
      const now = Date.now();
      const token = await mintSessionToken({ v: 1, sid, cid, iat: now, exp: now + SESSION_TTL_MS });
      const confirming = route === "call-confirm";
      const headers = new Headers({ "content-type": "application/json" });
      if (confirming) {
        headers.set("x-call-secret", secret);
        headers.set("x-trade-session-token", token);
      } else headers.set("authorization", "Bearer " + token);
      const request = new Request(req.url, { method: "POST", headers,
        body: JSON.stringify(confirming ? { ...terms, conversation_id: cid, is_text_only, history } : terms) });
      const response = await handleQuicknodeResearch(request, route, {}, "phone");
      const result = await response.json();
      return reply(200, { ok: result.ok, quote_id: result.quote_id ?? terms.quote_id,
        status: result.status, say: result.say ?? result.message, error: result.error });
    }
    if (call.direction === "outbound") {
      if (action !== "settlement" || typeof call.notice !== "string" || !/^[a-f0-9]{64}$/.test(call.notice)) return denied();
      const owner = accounts().find(a => a.phone === call.phone);
      if (!owner) return denied();
      const path = "accounts/" + owner.id + "/notifications/" + call.notice;
      const accepted = await read<{conversation_id: string}>(path + "/accepted");
      if (accepted?.conversation_id !== cid) return denied();
      const settlement = await read(path);
      return reply(200, { ok: !!settlement, settlement });
    }
    if (call.direction !== "inbound") return denied();
    if (action === "research-quote") return await research("quote");
    if (action === "research-confirm") return await research("call-confirm");
    if (action === "research-result") return await research("status");
    if (!["combo", "order-result", "positions", "prepare", "confirm"].includes(action))
      return reply(404, { ok: false });
    const demo = phoneDemoAccount();
    if (!demo) return reply(200, {ok:false, error:"PHONE_DEMO_UNAVAILABLE", say:"The phone demo’s Gemini Sandbox credentials are missing. Market quotes are still available."});
    return await phoneAccount.run(demo, async () => {
      const store = blobStore();
      const path = "accounts/" + demo.id + "/sessions/" + digest(cid);
      let session = await read<SessionClaims>(path);
      if (!session) {
        const now = Date.now();
        const candidate: SessionClaims = { v: 1, sid: crypto.randomUUID(), cid, iat: now, exp: now + SESSION_TTL_MS };
        await store.createSession(candidate.sid);
        session = await claim(path, candidate) ? candidate : await read<SessionClaims>(path);
      }
      if (!session || session.cid !== cid || session.exp <= Date.now()) return denied();
      const token = await mintSessionToken(session);
      if (action === "combo" || action === "order-result")
        return reply(200, await runBrowserTrading({ action: action === "combo" ? "build-combo" : action,
          method: "POST", token, body: terms }, store));
      if (action === "positions")
        return reply(
          200,
          await runBrowserTrading(
            { action: "portfolio", method: "POST", token, body: {} },
            store,
          ),
        );
      if (action === "prepare") {
        const r = await runBrowserTrading(
          { action: "proposals", method: "POST", token, body: terms },
          store,
        );
        return reply(
          200,
          r.ok && r.proposal
            ? { ok: true, proposal_id: r.proposal.proposal_id, say: r.proposal.voice_readback }
            : r,
        );
      }
      if (action === "confirm")
        return reply(
          200,
          await runBrowserTrading(
            {
              action: "call-confirm",
              method: "POST",
              token,
              callSecret: secret,
              body: { ...terms, conversation_id: cid, is_text_only, history },
            },
            store,
          ),
        );
      return reply(404, { ok: false });
    });
  } catch (e) {
    if (e instanceof TradeError)
      return reply(200, { ok: false, error: e.code, say: e.message });
    return reply(503, { ok: false, say: "The phone account service is unavailable." });
  }
}

import { accounts, digest, phoneAccount, verifyCode } from "./accounts";
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
    const { conversation_id: cid, history, is_text_only, code, ...terms } = b;
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
      const response = await handleQuicknodeResearch(request, route);
      const result = await response.json();
      return reply(200, { ok: result.ok, quote_id: result.quote_id ?? terms.quote_id,
        status: result.status, say: result.say ?? result.message, error: result.error });
    }
    if (action === "research-quote" && call.direction === "inbound") return await research("quote");
    const owner = accounts().find((a) => a.phone === call.phone);
    if (!owner) return reply(200, {ok:false, say:"Private trading requires an enrolled phone account. You can still ask for market quotes."});
    return await phoneAccount.run(owner, async () => {
      const store = blobStore(),
        prefix = "accounts/" + owner.id,
        path = prefix + "/sessions/" + digest(cid);
      let session = await read<SessionClaims>(path);
      if (session && session.exp <= Date.now()) return denied();
      if (!session && action === "authenticate") {
        const now = Date.now();
        // The five-minute attempt budget is shared across calls and server instances.
        let allowed = false;
        for (let i = 0; i < 5 && !allowed; i++)
          allowed = await claim(prefix + "/attempts/" + Math.floor(now / 300000) + "-" + i, true);
        if (!allowed) return denied();
        const step = verifyCode(owner.totpSecret, code, now);
        if (step === null || !(await claim(prefix + "/otp/" + step, true))) return denied();
        session = { v: 1, sid: crypto.randomUUID(), cid, iat: now, exp: now + SESSION_TTL_MS };
        await store.createSession(session.sid);
        if (!(await claim(path, session))) return denied();
      }
      if (!session)
        return reply(200, {
          ok: false,
          next_action: "phone_authenticate",
          say: "Use your authenticator code to verify this call first.",
        });
      if (action === "authenticate") {
        const notice =
          call.direction === "outbound" &&
          typeof call.notice === "string" &&
          /^[a-f0-9]{64}$/.test(call.notice)
            ? await read(prefix + "/notifications/" + call.notice)
            : null;
        return reply(200, { ok: true, authenticated: true, settlement: notice });
      }
      if (call.direction !== "inbound" && action !== "positions") return denied();
      if (action === "research-confirm") return research("call-confirm");
      if (action === "research-result") return research("status");
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
    if (e instanceof Error && e.message.startsWith("Invalid phone enrollment:"))
      return reply(200, {ok:false, error:"PHONE_ENROLLMENT_UNAVAILABLE", say:"Phone trading is unavailable until the account administrator finishes sandbox enrollment."});
    if (e instanceof TradeError)
      return reply(200, { ok: false, error: e.code, say: e.message });
    return reply(503, { ok: false, say: "The phone account service is unavailable." });
  }
}

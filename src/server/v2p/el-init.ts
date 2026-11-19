// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Optional ElevenLabs "Twilio personalization" webhook.
// Receives {caller_id, agent_id, called_number, call_sid, conversation_id};
// returns dynamic variables so the agent can greet returning callers.
// Must answer fast: a failed or slow webhook can stop the call from starting.
import { db, logActivity, touchCaller } from "./db";
import { corsHeaders, json, toolAuthorized } from "./util";

export async function handleElInit(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // deno-lint-ignore no-explicit-any
  let b: any = {};
  try { b = await req.json(); } catch { /* ignore */ }
  const caller = String(b.caller_id ?? "unknown");
  const vars: Record<string, string> = { caller_id: caller, returning_caller: "no", open_trades_note: "" };
  if (await toolAuthorized(req)) {
    try {
      const { returning, callCount } = await touchCaller(caller);
      vars.returning_caller = returning ? "yes" : "no";
      vars.call_count = String(callCount);
      const { count } = await db.from("orders").select("id", { count: "exact", head: true });
      vars.open_trades_note = count ? "This caller has traded before; offer to check their positions." : "";
      await logActivity("CALL_STARTED", caller, `Incoming call (${returning ? "returning caller" : "first call"})`, {
        call_sid: b.call_sid, conversation_id: b.conversation_id,
      });
    } catch (e) {
      console.error("el-init db error", e);
    }
  }
  return json({ type: "conversation_initiation_client_data", dynamic_variables: vars });
}

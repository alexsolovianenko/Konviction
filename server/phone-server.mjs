import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { PhoneStore } from "./phone-store.mjs";
import { pairPrompt, phoneDialog } from "./phone-dialog.mjs";
import { phoneConfig } from "./phone-config.mjs";

const base = "/phone/";
const actionPath = /^\/phone\/(turn|result)\/([0-9a-f-]{36})$/;
const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
function render(config, { state, prompt }, turn) {
  const xml = new twilio.twiml.VoiceResponse();
  // Read back all terms before listening. A caller cannot barge into confirmation.
  xml.say(prompt);
  if (state.step !== "end") {
    const pair = state.step === "pair";
    xml.gather({
      action: config.origin + base + "turn/" + turn,
      method: "POST",
      input: pair ? ["dtmf"] : ["speech"],
      ...(pair ? { numDigits: 8 } : { speechTimeout: "auto", language: "en-US" }),
      timeout: 8,
    });
    xml.say("No input received. Goodbye.");
  }
  xml.hangup();
  return xml.toString();
}

async function formBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) return null;
    chunks.push(chunk);
  }
  const fields = Object.create(null);
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString())) {
    if (Object.hasOwn(fields, key)) return null;
    fields[key] = value;
  }
  return fields;
}

export function createPhoneServer(repo, config = phoneConfig()) {
  const calls = new PhoneStore(repo, config);
  const dialog = phoneDialog(repo, calls);
  const ended = render(config, { state: { step: "end" }, prompt: "Call ended." });
  function result(sid, turn) {
    const row = calls.read(sid);
    if (!row || row.expires <= Date.now() || row.previous !== turn) return ended;
    if (row.response) return row.response;
    if (Date.now() - row.started > 45000)
      return render(config, {
        state: { step: "end" },
        prompt:
          "Result unavailable. Check your sandbox order history before placing another order.",
      });
    const xml = new twilio.twiml.VoiceResponse();
    xml.pause({ length: 2 });
    xml.redirect({ method: "POST" }, config.origin + base + "result/" + turn);
    return xml.toString();
  }
  return createServer(async (req, res) => {
    function reply(code, body = "") {
      res.writeHead(code, {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
    }
    try {
      const path = req.url;
      const action = actionPath.exec(path);
      if (!action && !["/phone/incoming", "/phone/status"].includes(path)) return reply(404);
      if (req.method !== "POST") return reply(405);
      if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded")
        return reply(415);
      const form = await formBody(req);
      if (!form) return reply(400);
      if (
        !twilio.validateRequest(
          config.token,
          req.headers["x-twilio-signature"] ?? "",
          config.origin + path,
          form,
        ) ||
        form.AccountSid !== config.account ||
        form.From !== config.from ||
        form.To !== config.to ||
        form.Direction !== "inbound" ||
        !/^CA[a-f0-9]{32}$/i.test(form.CallSid)
      )
        return reply(403);
      const sid = form.CallSid;
      if (path === "/phone/status") {
        if (terminal.has(form.CallStatus)) calls.stop(sid);
        return reply(204);
      }
      if (terminal.has(form.CallStatus)) {
        calls.stop(sid);
        return reply(200, ended);
      }
      if (path === "/phone/incoming")
        return reply(200, calls.start(sid, (turn) => render(config, pairPrompt, turn)) ?? ended);
      const [, kind, turn] = action;
      if (kind === "result") return reply(200, result(sid, turn));
      const fingerprint = calls.digest(
        "turn",
        sid,
        turn,
        form.Digits ?? "",
        form.SpeechResult ?? "",
      );
      const { state, replay } = calls.take(sid, turn, fingerprint);
      if (!state) return reply(200, replay ? result(sid, turn) : ended);
      const work = async () => {
        let next;
        try {
          next = await dialog(sid, turn, state, form);
        } catch (error) {
          const prompt =
            error.code === "CAP_EXCEEDED"
              ? "That order exceeds your sandbox spend limit."
              : error.code === "INACTIVE"
                ? "The quote expired. Request a fresh quote."
                : "Service unavailable. Check your sandbox order history before placing another order.";
          next = { state: { step: "end" }, prompt };
        }
        const nextTurn = next.state.step === "end" ? null : randomUUID();
        calls.finish(sid, turn, next.state, nextTurn, render(config, next, nextTurn));
      };
      // Slow exchange calls continue once. Twilio polls the original server-issued turn.
      let timeout;
      try {
        await Promise.race([
          work(),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, 4000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      return reply(200, result(sid, turn));
    } catch {
      return reply(503);
    }
  });
}

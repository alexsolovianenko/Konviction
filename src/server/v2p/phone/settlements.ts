import { accounts, digest, phoneAccount, type PhoneAccount } from "./accounts";
import { eleven } from "./provider";
import { claim } from "./store";
import { gPrivate } from "../gemini";
import { secretEqual } from "../util";

type Row = Record<string, unknown>;
export function settlement(row: Row, since: number) {
  const symbol = row["instrumentSymbol"] ?? row["symbol"],
    at = Date.parse(String(row["settledAt"]));
  const held = String(row["outcome"]).toLowerCase(),
    winner = String(row["resolutionSide"]).toLowerCase();
  const pnl = row["netProfit"];
  if (
    typeof symbol !== "string" ||
    !symbol ||
    !Number.isFinite(at) ||
    at < since ||
    at > Date.now() ||
    !["yes", "no"].includes(held) ||
    !["yes", "no"].includes(winner) ||
    !["number", "string"].includes(typeof pnl) ||
    !/^-?\d+(\.\d+)?$/.test(String(pnl)) ||
    !Number.isFinite(Number(pnl))
  )
    return null;
  const metadata = row["contractMetadata"] as { eventName?: string; contractName?: string } | null;
  return {
    id: digest(JSON.stringify([symbol, held, at])),
    report: {
      event: metadata?.eventName,
      contract: metadata?.contractName ?? symbol,
      outcome: held,
      resolution: winner,
      result: held === winner ? "win" : "loss",
      realized_pnl_usd: String(pnl),
      settled_at: new Date(at).toISOString(),
    },
  };
}

export async function notify(account: PhoneAccount, row: Row, reserve = claim, dial = eleven) {
  if (!account.notifySince) return;
  const entry = settlement(row, Date.parse(account.notifySince));
  if (!entry) return;
  const path = "accounts/" + account.id + "/notifications/" + entry.id;
  // Reserve before dialing. Even an ambiguous provider timeout leaves a durable claim.
  if (!(await reserve(path, entry.report))) return;
  const r = await dial("twilio/outbound-call", {
    agent_id: process.env["ELEVENLABS_AGENT_ID"],
    agent_phone_number_id: process.env["ELEVENLABS_PHONE_NUMBER_ID"],
    to_number: account.phone,
    conversation_initiation_client_data: {
      branch_id: process.env["ELEVENLABS_BRANCH_ID"],
      dynamic_variables: { settlement_ref: entry.id },
      conversation_config_override: {
        agent: {
          first_message:
            "This is Konviction with a private account update. To hear it, please give your current six-digit authenticator code.",
        },
      },
    },
  });
  if (r.success !== true) throw Error("Call submission unconfirmed");
  await reserve(path + "/accepted", {
    conversation_id: r.conversation_id,
    call_sid: r.callSid ?? r.call_sid,
  });
}

export async function checkSettlements(req: Request) {
  const key = process.env["CRON_SECRET"];
  if (!key || !(await secretEqual(req.headers.get("authorization") ?? "", "Bearer " + key)))
    return new Response(null, { status: 401 });
  let failures = 0;
  for (const owner of accounts().filter((a) => a.notifySince)) {
    try {
      await phoneAccount.run(owner, async () => {
        for (let offset = 0; ; offset += 100) {
          const r = await gPrivate(
            "/v1/prediction-markets/positions/settled",
            {},
            { query: { sort: "-date", offset, limit: 100 } },
          );
          const rows: Row[] = r.data?.positions;
          if (!r.ok || !Array.isArray(rows)) throw Error("Settlement feed unavailable");
          for (const row of rows) {
            try {
              await notify(owner, row);
            } catch {
              failures++;
            }
          }
          if (
            rows.length < 100 ||
            (rows.length &&
              Date.parse(String(rows.at(-1)?.["settledAt"])) < Date.parse(owner.notifySince!))
          )
            break;
        }
      });
    } catch {
      failures++;
    }
  }
  return Response.json(
    { ok: failures === 0, failures },
    { status: failures ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}

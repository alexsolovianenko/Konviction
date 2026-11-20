import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { accounts, phoneAccount, type PhoneAccount } from "./accounts";
import { secretEqual } from "../util";
import { scanSettlements } from "./settlements";

export function settlementEvent(message: string) {
  try {
    const frame = JSON.parse(message);
    const event = frame.data ?? frame;
    return (
      event.e === "positionReport" &&
      Array.isArray(event.P) &&
      event.P.some(
        (row: { a?: { t: string }[] }) =>
          Array.isArray(row.a) && row.a.some((a) => a.t === "settlement_payout"),
      )
    );
  } catch {
    return false;
  }
}

// A websocket event wakes the scan immediately. The timer also catches a delayed
// P&L record or a missed event while the Gemini stream reconnects.
export async function monitor(
  account: PhoneAccount,
  durationMs: number,
  check: () => Promise<void>,
  connect: (account: PhoneAccount, wake: () => void) => { terminate(): void } = openStream,
) {
  let pending = false;
  let running: Promise<void> | undefined;
  let closed = false;
  let lastError: unknown;
  const flush = () => {
    if (closed) return;
    pending = true;
    if (!running)
      running = (async () => {
        while (pending && !closed) {
          pending = false;
          try {
            await check();
            lastError = undefined;
          } catch (e) {
            lastError = e;
          }
        }
      })().finally(() => {
        running = undefined;
      });
  };
  const socket = connect(account, flush);
  const timer = setInterval(flush, 5000);
  flush();
  try {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } finally {
    closed = true;
    clearInterval(timer);
    socket.terminate();
    await running;
  }
  if (lastError) throw lastError;
}

function openStream(account: PhoneAccount, wake: () => void) {
  const nonce = String(Math.floor(Date.now() / 1000));
  const payload = Buffer.from(nonce).toString("base64");
  const socket = new WebSocket("wss://ws.sandbox.gemini.com", {
    handshakeTimeout: 5000,
    headers: {
      "X-GEMINI-APIKEY": account.apiKey,
      "X-GEMINI-NONCE": nonce,
      "X-GEMINI-PAYLOAD": payload,
      "X-GEMINI-SIGNATURE": createHmac("sha384", account.apiSecret).update(payload).digest("hex"),
    },
  });
  socket.on("open", () =>
    socket.send(JSON.stringify({ id: "1", method: "SUBSCRIBE", params: ["positions@account"] })),
  );
  socket.on("message", (raw) => {
    if (settlementEvent(raw.toString())) wake();
  });
  socket.on("error", () => {}); // Timer-based reconciliation continues until the next worker connects.
  return socket;
}

export async function watchRequest(req: Request) {
  const secret = process.env["CRON_SECRET"];
  if (!secret || !(await secretEqual(req.headers.get("authorization") ?? "", "Bearer " + secret)))
    return new Response(null, { status: 401 });
  const owners = accounts().filter((owner) => owner.notifySince);
  const result = await Promise.allSettled(
    owners.map((owner) =>
      phoneAccount.run(owner, async () => {
        const seen = new Set<string>();
        await monitor(owner, 65000, async () => {
          // The daily reconciliation also recovers older rows after prolonged outages.
          const since = Math.max(Date.parse(owner.notifySince!), Date.now() - 60 * 60 * 1000);
          if (await scanSettlements(owner, since, seen)) throw Error("Settlement scan incomplete");
        });
      }),
    ),
  );
  const ok = result.every((r) => r.status === "fulfilled");
  return Response.json(
    { ok, accounts: owners.length },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

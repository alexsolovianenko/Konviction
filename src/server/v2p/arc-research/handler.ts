// HTTP surface for research. Auth = the server-signed voice session bearer (same token the
// browser already holds; never visible to the language model). Spending happens only through
// "approve", which the voice agent has no tool for; the on-screen button calls it.
import { verifySessionToken } from "../browser-session";
import { env } from "../util";
import { formatUsdcAtomic, researchConfig } from "./config";
import { ResearchError, blobIO, memoryIO, researchStore, type ResearchStore } from "./store";
import { researchService, type Deps } from "./service";
import { researchAccount } from "./wallet";

let memoryStore: ResearchStore | null = null;
// Without Vercel Blob, quotes still work from per-process memory, but approval refuses to pay
// (StoreIO.durable is false), so a missing store can never weaken the payment guarantees.
const defaultStore = (): ResearchStore => {
  if (env("BLOB_READ_WRITE_TOKEN") || env("BLOB_STORE_ID")) return researchStore(blobIO);
  return (memoryStore ??= researchStore(memoryIO()));
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const keysAre = (b: unknown, allowed: string[]) =>
  Boolean(b) &&
  typeof b === "object" &&
  !Array.isArray(b) &&
  Object.keys(b as object).every((k) => allowed.includes(k));

export async function handleArcResearch(
  req: Request,
  action: string,
  deps?: Partial<Deps>,
): Promise<Response> {
  try {
    const cfg = deps?.cfg ?? researchConfig();
    if (req.method === "GET" && action === "config") {
      return reply(200, {
        ok: true,
        payments_enabled:
          cfg.paymentsEnabled &&
          Boolean((deps?.account ?? researchAccount)()) &&
          (deps?.store ?? defaultStore()).io.durable,
        persistent_storage: (deps?.store ?? defaultStore()).io.durable,
        networks: cfg.networks,
        asset: cfg.asset,
        max_per_call_usd: formatUsdcAtomic(cfg.maxPerCallAtomic),
        max_per_day_usd: formatUsdcAtomic(cfg.maxPerDayAtomic),
        research_wallet: (deps?.account ?? researchAccount)()?.address ?? null,
      });
    }
    if (req.method !== "POST") return reply(404, { ok: false, error: "NOT_FOUND" });
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
      return reply(415, { ok: false, error: "JSON_REQUIRED" });
    const text = await req.text();
    if (text.length > 2048) return reply(413, { ok: false, error: "TOO_LARGE" });
    let body: Record<string, unknown>;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return reply(400, { ok: false, error: "BAD_INPUT" });
    }
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const claims = await verifySessionToken(token);
    if (!claims)
      return reply(401, {
        ok: false,
        error: "UNAUTHORIZED",
        message: "Start a voice session first.",
      });

    const svc = researchService({
      store: deps?.store ?? defaultStore(),
      cfg,
      account: researchAccount,
      ...deps,
    });
    const sid = claims.sid;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    switch (action) {
      case "quote":
        if (!keysAre(body, ["event_ticker", "contract_symbol"]))
          return reply(400, { ok: false, error: "BAD_INPUT" });
        return reply(200, {
          ok: true,
          ...(await svc.quote({
            sid,
            eventTicker: str("event_ticker"),
            contractSymbol: str("contract_symbol") || null,
          })),
        });
      case "approve":
        // Separate from trade approval: this token can only buy research, never place an order.
        if (
          !keysAre(body, ["quote_id", "max_atomic", "confirm"]) ||
          body["confirm"] !== "APPROVE_RESEARCH_PAYMENT"
        )
          return reply(400, { ok: false, error: "BAD_INPUT" });
        return reply(200, {
          ok: true,
          ...(await svc.approve({ sid, quoteId: str("quote_id"), maxAtomic: str("max_atomic") })),
        });
      case "status":
        if (!keysAre(body, ["quote_id"])) return reply(400, { ok: false, error: "BAD_INPUT" });
        return reply(200, { ok: true, ...(await svc.status({ sid, quoteId: str("quote_id") })) });
      case "recent":
        return reply(200, { ok: true, purchases: await svc.recent(sid) });
      default:
        return reply(404, { ok: false, error: "NOT_FOUND" });
    }
  } catch (e) {
    if (e instanceof ResearchError)
      return reply(e.status, { ok: false, error: e.code, message: e.message, say: e.message });
    console.error(
      JSON.stringify({
        event: "arc_research_error",
        action,
        error_name: (e as Error)?.name ?? null,
      }),
    );
    return reply(503, {
      ok: false,
      error: "SERVICE_UNAVAILABLE",
      message: "Research unavailable. Nothing new was paid.",
      say: "Research is unavailable right now.",
    });
  }
}

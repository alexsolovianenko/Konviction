// HTTP surface for QuickNode crypto research.
//   context  (POST, public): free market identification + verified context. Never pays.
//   quote    (POST, voice-session bearer): context + unpaid x402 quote bound to the session.
//   approve  (POST, voice-session bearer): the on-screen button only. No voice tool can call it.
//   status   (POST, voice-session bearer) and config (GET, public).
import { verifySessionToken } from "../browser-session";
import { env } from "../util";
import { formatUsdc, QUICKNODE_NETWORKS_URL, researchConfig } from "./config";
import { defaultSdkFactory } from "./paid-request";
import { researchService, type Deps } from "./service";
import { blobIO, memoryIO, ResearchError, researchStore, type ResearchStore } from "./store";
import { loadResearchWallet, walletConfigured } from "./wallet";

let memoryStore: ResearchStore | null = null;
// Without Vercel Blob, quotes still work from per-process memory, but approval refuses to pay
// (StoreIO.durable is false), so missing storage can never weaken the payment guarantees.
const defaultStore = (): ResearchStore => {
  if (env("BLOB_READ_WRITE_TOKEN")) return researchStore(blobIO);
  return (memoryStore ??= researchStore(memoryIO()));
};

/** Read-only Gemini Sandbox event + contract (public endpoint; no trading code). */
const geminiMarket: Deps["market"] = async (eventTicker, contractSymbol) => {
  const { getEvent, findContract } = await import("../gemini");
  const { event } = await getEvent(eventTicker);
  return { event, contract: findContract(event, contractSymbol) };
};

/** Read-only settlement-index klines from Gemini Sandbox's public market data. */
const geminiKlines: Deps["klines"] = async (agency, index, from, to) => {
  const { gPublic } = await import("../gemini");
  const r = await gPublic("/v2/klines", {
    agency,
    index,
    interval: "1m",
    startTime: from,
    endTime: to,
  });
  return r.ok ? r.data : null;
};

let networksCache: { at: number; list: string[] } | null = null;
/** QuickNode's free list of supported x402 networks, cached for 10 minutes. Null when unavailable. */
const quicknodeNetworks: Deps["networks"] = async () => {
  if (networksCache && Date.now() - networksCache.at < 10 * 60_000) return networksCache.list;
  const res = await fetch(QUICKNODE_NETWORKS_URL, {
    redirect: "manual",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { networks?: unknown };
  const list = Array.isArray(data.networks)
    ? data.networks.filter((n): n is string => typeof n === "string" && /^[a-z0-9-]{2,60}$/.test(n))
    : [];
  if (!list.length) return null;
  networksCache = { at: Date.now(), list };
  return list;
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const keysAre = (b: Record<string, unknown>, allowed: string[], required: string[] = allowed) =>
  Object.keys(b).every((k) => allowed.includes(k)) &&
  required.every((k) => typeof b[k] === "string");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APPROVAL_PHRASE = "APPROVE_QUICKNODE_RESEARCH_PAYMENT";

export async function handleQuicknodeResearch(
  req: Request,
  action: string,
  deps: Partial<Deps> = {},
): Promise<Response> {
  try {
    const cfg = deps.cfg ?? researchConfig();
    const store = deps.store ?? defaultStore();
    if (req.method === "GET" && action === "config") {
      return reply(200, {
        ok: true,
        payments_enabled:
          cfg.paymentsEnabled &&
          store.io.durable &&
          Boolean(cfg.expectedSender) &&
          (deps.wallet ? true : walletConfigured()),
        persistent_storage: store.io.durable,
        network: cfg.network,
        asset: cfg.asset,
        max_per_request_usdc: formatUsdc(cfg.maxPerRequest),
        max_per_session_usdc: formatUsdc(cfg.maxPerSession),
        max_per_day_usdc: formatUsdc(cfg.maxPerDay),
        research_wallet: cfg.expectedSender,
      });
    }
    if (req.method !== "POST") return reply(404, { ok: false, error: "NOT_FOUND" });
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
      return reply(415, { ok: false, error: "JSON_REQUIRED" });
    const text = await req.text();
    if (text.length > 2048) return reply(413, { ok: false, error: "TOO_LARGE" });
    let body: Record<string, unknown>;
    try {
      const parsed = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return reply(400, { ok: false, error: "BAD_INPUT" });
    }
    const svc = researchService({
      store,
      cfg,
      fetchImpl: deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      wallet: deps.wallet ?? loadResearchWallet,
      sdk: deps.sdk ?? defaultSdkFactory,
      market: deps.market ?? geminiMarket,
      klines: deps.klines ?? geminiKlines,
      networks: deps.networks ?? quicknodeNetworks,
    });
    const s = (k: string) => String(body[k] ?? "");
    // No URL, method or RPC body is ever accepted: only the selected Gemini market.
    const marketOnly = () => keysAre(body, ["event_ticker", "contract_symbol"]);
    if (action === "context") {
      if (!marketOnly()) return reply(400, { ok: false, error: "BAD_INPUT" });
      return reply(200, {
        ok: true,
        ...(await svc.context({
          eventTicker: s("event_ticker"),
          contractSymbol: s("contract_symbol"),
        })),
      });
    }
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const claims = await verifySessionToken(token);
    if (!claims)
      return reply(401, {
        ok: false,
        error: "UNAUTHORIZED",
        message: "Start a voice session first.",
        say: "Start a voice session first.",
      });
    const sid = claims.sid;
    switch (action) {
      case "quote":
        if (!marketOnly()) return reply(400, { ok: false, error: "BAD_INPUT" });
        return reply(200, {
          ok: true,
          ...(await svc.quote({
            sid,
            eventTicker: s("event_ticker"),
            contractSymbol: s("contract_symbol"),
          })),
        });
      case "approve":
        // Separate from trade approval: this can only buy the quote's fixed research request.
        if (
          !keysAre(body, ["quote_id", "max_atomic", "confirm", "idempotency_key"]) ||
          body["confirm"] !== APPROVAL_PHRASE ||
          !UUID.test(s("idempotency_key"))
        )
          return reply(400, { ok: false, error: "BAD_INPUT" });
        return reply(200, {
          ok: true,
          ...(await svc.approve({
            sid,
            quoteId: s("quote_id"),
            maxAtomic: s("max_atomic"),
            idempotencyKey: s("idempotency_key"),
          })),
        });
      case "status":
        if (!keysAre(body, ["quote_id"])) return reply(400, { ok: false, error: "BAD_INPUT" });
        return reply(200, { ok: true, ...(await svc.status({ sid, quoteId: s("quote_id") })) });
      default:
        return reply(404, { ok: false, error: "NOT_FOUND" });
    }
  } catch (e) {
    if (e instanceof ResearchError)
      return reply(e.status, { ok: false, error: e.code, message: e.message, say: e.message });
    console.error(
      JSON.stringify({
        event: "quicknode_research_error",
        action,
        error_name: (e as Error)?.name ?? null,
      }),
    );
    return reply(503, {
      ok: false,
      error: "SERVICE_UNAVAILABLE",
      message: "Research unavailable. No new payment was started.",
      say: "Research is unavailable right now.",
    });
  }
}

// Research flow: quote (free, unpaid 402) -> on-screen approval -> sign once -> paid request
// -> store response -> verify onchain transfer -> compare with Gemini.
// Imports are deliberately limited: Gemini public reads, session verification and util.
// Nothing here imports the trade engine, the trading ledger or order submission.
import type { Hex, LocalAccount } from "viem";
import { getEvent, type Contract, type GEvent } from "../gemini";
import { LIMITS } from "../util";
import { researchConfig, formatUsdcAtomic, providerAllowed, type ResearchConfig } from "./config";
import {
  parsePaymentRequired,
  parseSettlementResponse,
  selectRequirement,
  rejectReason,
  b64encodeJson,
} from "./x402";
import { buildAuthorization, signAuthorization, paymentPayload } from "./eip3009";
import { verifyTransfer, authorizationUsed } from "./verify";
import {
  ASSET_QUERY,
  compare,
  detectAsset,
  detectStructure,
  extractMarkets,
  spokenSummary,
  type GeminiSide,
} from "./compare";
import { ResearchError, type Purchase, type ResearchStore } from "./store";

export type Deps = {
  store: ResearchStore;
  cfg?: ResearchConfig;
  fetchImpl?: typeof fetch;
  account?: () => LocalAccount | null;
  loadEvent?: (ticker: string) => Promise<{ event: GEvent | null; error?: string }>;
  randomNonce?: () => Hex;
  now?: () => number;
};

const QUOTE_TTL_MS = 4 * 60_000; // inside BlockRun's 300 s maxTimeoutSeconds
// Longer than signing plus the 20 s paid request. A purchase still "signing" after this was
// interrupted (e.g. the function was killed); it is resolved onchain, never signed again.
export const SIGNING_STALE_MS = 2 * 60_000;

const randomHex = (): Hex =>
  ("0x" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")) as Hex;

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function geminiSide(ev: GEvent, symbol?: string | null): GeminiSide {
  const contracts = (ev.contracts ?? []).filter((c) => !c.isCombo);
  const ask = (c: Contract) => Number(c.prices?.buy?.yes ?? NaN);
  const contract =
    (symbol ? contracts.find((c) => c.instrumentSymbol === symbol) : null) ??
    [...contracts].sort((a, b) => Math.abs((ask(a) || 9) - 0.5) - Math.abs((ask(b) || 9) - 0.5))[0];
  if (!contract)
    throw new ResearchError("NO_CONTRACT", "That Gemini market has no open contracts.", 404);
  const label = contract.label ?? contract.abbreviatedName ?? "";
  const sd = (ev as { sourceDetails?: { agency?: string; index?: string } }).sourceDetails;
  const yesAsk = Number.isFinite(ask(contract)) ? ask(contract) : null;
  const bid = Number(contract.prices?.sell?.yes ?? NaN);
  const strike = Number(contract.strike?.value ?? NaN);
  return {
    eventTicker: ev.ticker ?? "",
    title: ev.title ?? "",
    asset: detectAsset(`${ev.ticker ?? ""} ${ev.title ?? ""}`),
    contractLabel: label,
    strike: Number.isFinite(strike) ? strike : null,
    structure: /^(up|down)$/i.test(label.trim()) ? "up_down" : detectStructure(label),
    expiry: contract.expiryDate ?? ev.expiryDate ?? null,
    settlement: sd ? [sd.agency, sd.index].filter(Boolean).join(" ") : null,
    yesAsk,
    yesBid: Number.isFinite(bid) ? bid : null,
    feePerContractEst:
      yesAsk !== null ? Math.round(LIMITS.takerRate * yesAsk * (1 - yesAsk) * 10000) / 10000 : null,
  };
}

function publicView(p: Purchase, cfg: ResearchConfig) {
  return {
    quote_id: p.id,
    status: p.status,
    provider: "BlockRun (Predexon data)",
    endpoint: new URL(p.resource_url).pathname,
    query: p.query,
    price_atomic: p.requirement.amount,
    price_usd: formatUsdcAtomic(p.requirement.amount),
    network: p.requirement.network,
    asset: p.requirement.asset,
    pay_to: p.requirement.payTo,
    payer: p.payer,
    tx_hash: p.tx_hash,
    explorer_url: p.tx_hash ? cfg.explorerTx(p.requirement.network, p.tx_hash) : null,
    block_number: p.block_number,
    expires_at: new Date(p.expires_at).toISOString(),
    error: p.error,
    gemini: p.gemini,
  };
}

export function researchService(deps: Deps) {
  const cfg = deps.cfg ?? researchConfig();
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const loadEvent = deps.loadEvent ?? getEvent;
  const account = deps.account ?? (() => null);
  const { store } = deps;

  async function quote({
    sid,
    eventTicker,
    contractSymbol,
  }: {
    sid: string;
    eventTicker: string;
    contractSymbol?: string | null;
  }) {
    if (!/^[A-Z0-9_-]{3,64}$/i.test(eventTicker))
      throw new ResearchError("BAD_INPUT", "Unknown market.");
    const { event, error } = await loadEvent(eventTicker);
    if (!event)
      throw new ResearchError("GEMINI_UNAVAILABLE", error ?? "Gemini market unavailable.", 502);
    const gemini = geminiSide(event, contractSymbol ?? null);
    if (!gemini.asset || !ASSET_QUERY[gemini.asset])
      throw new ResearchError(
        "UNSUPPORTED",
        "Cross-venue research covers crypto price markets only.",
        422,
      );
    const query = ASSET_QUERY[gemini.asset] as string;
    if (!providerAllowed(cfg.url))
      throw new ResearchError("PROVIDER_NOT_ALLOWED", "Research provider is not on the allowlist.", 422);
    const url = new URL(cfg.url);
    url.searchParams.set("q", query);
    const res = await f(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (res.status !== 402)
      throw new ResearchError(
        "UNEXPECTED_PROVIDER",
        `Provider returned HTTP ${res.status} without a price.`,
        502,
      );
    const pr = parsePaymentRequired(res.headers, text);
    if (!pr) throw new ResearchError("NO_PRICE", "Provider did not state a price.", 502);
    const v = selectRequirement(pr, cfg);
    if (!v.ok) throw new ResearchError("REFUSED", "Research refused: " + v.reason, 422);
    const id = await store.insertQuote({
      sid,
      expires_at: now() + QUOTE_TTL_MS,
      gemini,
      query,
      resource_url: url.toString(),
      requirement: v.requirement,
    });
    const p = await store.get(id);
    return {
      ...publicView(p as Purchase, cfg),
      payments_enabled: cfg.paymentsEnabled && store.io.durable,
      say: `I can check Kalshi and Polymarket for similar contracts. It costs ${formatUsdcAtomic(v.requirement.amount)} in USDC on Arc from the research wallet, not your trading balance. Approve it on screen if you want it.`,
    };
  }

  /** Called only from the authenticated on-screen button. Signs at most once per quote. */
  async function approve({
    sid,
    quoteId,
    maxAtomic,
  }: {
    sid: string;
    quoteId: string;
    maxAtomic: string;
  }) {
    const existing = await store.get(quoteId);
    if (!existing || existing.sid !== sid)
      throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
    if (existing.status !== "quoted") return status({ sid, quoteId });
    if (!/^\d+$/.test(maxAtomic) || BigInt(existing.requirement.amount) > BigInt(maxAtomic))
      throw new ResearchError("PRICE_CHANGED", "Price is above what you approved.", 409);
    if (!cfg.paymentsEnabled)
      throw new ResearchError(
        "PAYMENTS_DISABLED",
        "Research payments are switched off on this server. Nothing was paid.",
        503,
      );
    // Fail closed: never pay with per-process storage. The daily cap, unique nonces and the
    // single-signature guarantee only hold when every instance shares one durable store.
    if (!store.io.durable)
      throw new ResearchError(
        "STORAGE_REQUIRED",
        "Research payments need persistent storage (Vercel Blob). Nothing was paid.",
        503,
      );
    const acct = account();
    if (!acct)
      throw new ResearchError(
        "WALLET_MISSING",
        "Research wallet not configured. Nothing was paid.",
        503,
      );
    if (!cfg.rpcUrl(existing.requirement.network))
      throw new ResearchError("RPC_MISSING", "No Arc RPC configured. Nothing was paid.", 503);
    // Re-check the stored quote against the current allowlists and caps before anything is signed.
    const refused = rejectReason(existing.requirement, cfg);
    if (refused) throw new ResearchError("REFUSED", "Research refused: " + refused + " Nothing was paid.", 422);
    if (!providerAllowed(existing.resource_url))
      throw new ResearchError("PROVIDER_NOT_ALLOWED", "Research provider is not on the allowlist. Nothing was paid.", 422);

    const nonce = (deps.randomNonce ?? randomHex)();
    const auth = buildAuthorization(acct, existing.requirement, nonce, Math.floor(now() / 1000));
    const won = await store.beginSigning(
      quoteId,
      sid,
      acct.address,
      nonce,
      auth.validBefore,
      cfg.maxPerDayAtomic,
    );
    if (!won) return status({ sid, quoteId });

    let res: Response;
    try {
      const signature = await signAuthorization(acct, won.requirement, auth);
      const header = b64encodeJson(
        paymentPayload(won.requirement, signature, auth, { url: won.resource_url }),
      );
      res = await f(won.resource_url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json", "PAYMENT-SIGNATURE": header, "X-PAYMENT": header },
      });
    } catch (e) {
      await store.patch(quoteId, {
        status: "unknown_after_sign",
        error:
          "Paid request did not complete; checking chain. " + String((e as Error)?.message ?? ""),
      });
      return status({ sid, quoteId });
    }
    const text = await res.text();
    const settlement = parseSettlementResponse(res.headers);
    const tx =
      typeof settlement?.transaction === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)
        ? settlement.transaction
        : null;
    if (res.status === 200) {
      await store.io.putResponse(quoteId, text.slice(0, 500_000));
      await store.patch(quoteId, {
        status: "paid",
        http_status: 200,
        tx_hash: tx,
        settlement,
        response_sha256: await sha256(text),
        error: null,
      });
    } else {
      await store.patch(quoteId, {
        status: "unknown_after_sign",
        http_status: res.status,
        tx_hash: tx,
        settlement,
        error: `Provider answered HTTP ${res.status} after signing: ${text.slice(0, 160)}`,
      });
    }
    return status({ sid, quoteId });
  }

  /** Read-only progress, with onchain verification. Never signs. */
  async function status({ sid, quoteId }: { sid: string; quoteId: string }) {
    let p = await store.get(quoteId);
    if (!p || p.sid !== sid) throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
    if (p.status === "signing" && now() - p.updated_at > SIGNING_STALE_MS)
      p = (await store.patchIf(quoteId, "signing", {
        status: "unknown_after_sign",
        error: "Payment was interrupted after approval; checking Arc. It will not be signed again.",
      })) ?? (await store.get(quoteId)) ?? p;
    const rpc = cfg.rpcUrl(p.requirement.network);
    if (p.status === "paid" && p.tx_hash && rpc && p.payer) {
      const v = await verifyTransfer(
        {
          rpcUrl: rpc,
          txHash: p.tx_hash,
          asset: p.requirement.asset,
          from: p.payer,
          to: p.requirement.payTo,
          amount: p.requirement.amount,
        },
        f,
      );
      if (v.status === "settled_onchain")
        p = await store.patch(quoteId, {
          status: "settled_onchain",
          settled_at: now(),
          block_number: v.blockNumber,
        });
      else if (v.status === "mismatch")
        p = await store.patch(quoteId, { error: "Payment proof mismatch: " + v.reason });
    } else if (p.status === "paid" && !p.tx_hash && rpc && p.payer && p.eip3009_nonce) {
      // 200 without a settlement hash: BlockRun does not charge when nothing matches. Prove it onchain.
      const used = await authorizationUsed(
        { rpcUrl: rpc, asset: p.requirement.asset, from: p.payer, nonce: p.eip3009_nonce },
        f,
      );
      const expired = p.valid_before !== null && now() / 1000 > Number(p.valid_before) + 30;
      if (used === false && expired)
        p = await store.patch(quoteId, { status: "free_no_match", error: null });
      else if (used === true)
        p = await store.patch(quoteId, {
          error:
            "Authorization used onchain but no transaction hash returned; find it in the explorer by payer.",
        });
    } else if (p.status === "unknown_after_sign" && rpc && p.payer && p.eip3009_nonce) {
      const used = await authorizationUsed(
        { rpcUrl: rpc, asset: p.requirement.asset, from: p.payer, nonce: p.eip3009_nonce },
        f,
      );
      const expired = p.valid_before !== null && now() / 1000 > Number(p.valid_before) + 30;
      if (used === false && expired)
        p = await store.patch(quoteId, {
          status: "failed",
          error: "Authorization expired unused. No money moved.",
        });
      else if (used === true)
        p = await store.patch(quoteId, {
          error: "Authorization was used onchain, but the provider response was lost.",
        });
    }
    const view = publicView(p, cfg);
    if (p.status !== "paid" && p.status !== "settled_onchain")
      return { ...view, comparison: null, say: sayFor(p) };

    const raw = await store.io.getResponse(quoteId);
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    // Fresh Gemini read for the current ask; fall back to the quote-time snapshot.
    let gemini = p.gemini;
    try {
      const fresh = await loadEvent(p.gemini.eventTicker);
      if (fresh.event) gemini = pickSame(fresh.event, p.gemini);
    } catch {
      /* keep snapshot */
    }
    const markets = extractMarkets(payload);
    const rows = compare(gemini, markets, 6, now());
    return {
      ...view,
      gemini,
      comparison: {
        markets_found: markets.length,
        rows,
        summary: spokenSummary(gemini, rows),
        disclaimer: "Research is not your trading instruction. Orders need separate approval.",
      },
      say:
        (p.status === "settled_onchain"
          ? `Paid ${formatUsdcAtomic(p.requirement.amount)}, settled on Arc. `
          : `Paid; confirming on Arc. `) + spokenSummary(gemini, rows),
    };
  }

  return {
    quote,
    approve,
    status,
    recent: (sid: string) => store.recent(sid).then((rows) => rows.map((p) => publicView(p, cfg))),
  };
}

/** Keep the same contract (by label) the user was quoted on, with fresh prices. */
function pickSame(ev: GEvent, snap: GeminiSide): GeminiSide {
  const c = (ev.contracts ?? []).find((x) => (x.label ?? x.abbreviatedName) === snap.contractLabel);
  return c?.instrumentSymbol ? geminiSide(ev, c.instrumentSymbol) : snap;
}

function sayFor(p: Purchase): string {
  switch (p.status) {
    case "quoted":
      return "Waiting for your on-screen approval.";
    case "signing":
      return "Paying now.";
    case "unknown_after_sign":
      return "Payment may have gone through. I'm checking Arc before saying anything else.";
    case "failed":
      return p.error ?? "Research failed. Nothing was paid.";
    case "expired":
      return "That research quote expired. Nothing was paid.";
    case "free_no_match":
      return "No comparable markets found, so there was no charge.";
    default:
      return "Research in progress.";
  }
}

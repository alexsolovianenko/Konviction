// QuickNode x402 crypto research service.
//   context: free, public: identify the exact Gemini market + asset, build verified market context.
//   quote:   session-bound: context + (when a paid route exists) an unpaid x402 quote.
//   approve: session-bound, UI-only: one paid request on the quote's fixed route.
// Never imports or calls the Gemini trade engine. Gemini is read only (public event + index data).
import type { Contract, GEvent } from "../gemini";
import { AssetError, identifyMarket } from "./asset";
import { formatUsdc, type ResearchConfig } from "./config";
import { buildContext, type KlineSource, type MarketContext } from "./context";
import { runPaidRequest, type SdkFactory } from "./paid-request";
import {
  chooseRoute,
  readRoute,
  resourceLabel,
  routeBody,
  routeById,
  routeUrl,
  type Route,
} from "./routes";
import { ResearchError, type Evidence, type Purchase, type ResearchStore } from "./store";
import type { ResearchWallet } from "./wallet";
import {
  decodePaymentResponse,
  parsePaymentRequired,
  QuoteRejected,
  selectLikeSdk,
  validateRequirement,
} from "./x402";

export type Deps = {
  store: ResearchStore;
  cfg: ResearchConfig;
  /** Unpaid probe transport. Must never carry payment or credentials. */
  fetchImpl: typeof fetch;
  wallet: () => Promise<ResearchWallet | null>;
  sdk: SdkFactory;
  /** Read-only Gemini Sandbox event + contract lookup. */
  market: (
    eventTicker: string,
    contractSymbol: string,
  ) => Promise<{ event: GEvent | null; contract: Contract | null }>;
  /** Read-only settlement-index klines. */
  klines: KlineSource;
  /** QuickNode's live list of supported networks, or null when unavailable. */
  networks: () => Promise<string[] | null>;
};

const ID = /^[A-Za-z0-9._:-]{1,96}$/;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const blankEvidence = (): Evidence => ({
  http_status: null,
  rpc_error: null,
  request_id: null,
  api_ms: null,
  payment_response: null,
  payment_response_present: false,
  signed: false,
  gateway_available_before: null,
  gateway_available_after: null,
  gateway_deduction_atomic: null,
  response_sha256: null,
});

const fmt = (n: number) =>
  Math.abs(n) >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(n);

/** One-sentence grounded context summary for the agent and the card. */
export function contextSummary(c: MarketContext): string {
  const who = `${c.asset.name ?? c.asset.symbol} (${c.asset.symbol})`;
  const parts = [
    c.implied_yes_pct !== null
      ? `${who}: the market prices YES on "${c.market.contract_label ?? "this contract"}" at about ${c.implied_yes_pct}%.`
      : `${who}: no YES price is available on this contract right now.`,
  ];
  if (c.spot) {
    parts.push(
      `Its settlement index is ${fmt(c.spot.last)}, ${c.spot.change_60m_pct === null ? "" : `${c.spot.change_60m_pct > 0 ? "+" : ""}${c.spot.change_60m_pct}% over ${c.spot.minutes} minutes, `}` +
        (c.spot.distance_to_strike_pct === null
          ? ""
          : `${Math.abs(c.spot.distance_to_strike_pct)}% ${c.spot.distance_to_strike_pct > 0 ? "below" : "above"} the strike.`),
    );
  }
  return parts.join(" ").replace(/, $/, ".").trim();
}

type View = ReturnType<typeof purchaseView>;

function routeInfo(route: Route | null) {
  return route
    ? {
        route_id: route.id,
        research_chain: route.chain,
        quicknode_network: route.network,
        resource: resourceLabel(route),
      }
    : { route_id: null, research_chain: null, quicknode_network: null, resource: null };
}

/** Client-safe projection. Never includes keys, signatures, payment headers or session JWTs. */
export function purchaseView(p: Purchase, cfg: ResearchConfig) {
  const route = routeById(p.route_id);
  const price = formatUsdc(p.price_atomic);
  const r = p.report;
  const chain = route?.chain ?? "network";
  const sayFor: Record<string, string> = {
    quoted: `${contextSummary(p.context)} Extra ${chain} network research from QuickNode costs ${price} testnet USDC on Arc. Approve it on screen if you want it.`,
    free: (r ? r.headline + " " : "") + "QuickNode answered without charging.",
    expired: "That research quote expired. Nothing was paid.",
    reserved: "Research payment is starting.",
    sending: "Research payment is in progress.",
    paid:
      (r ? r.headline : "QuickNode was paid but the data could not be read.") +
      ` Paid ${price} testnet USDC through Circle Gateway; it settles in batches.`,
    unknown_pending:
      "The research payment status is unknown. It will not be retried automatically.",
    failed: "Research did not complete. Nothing was paid.",
  };
  return {
    quote_id: p.id,
    status: p.status as Purchase["status"] | "context_only",
    provider: "QuickNode x402",
    ...routeInfo(route),
    network: p.requirement?.network ?? cfg.network,
    network_label: "Arc Testnet",
    payment_asset: cfg.asset,
    pay_to: p.requirement?.payTo ?? null,
    payment_model: "Circle Gateway nanopayment (batched)",
    price_atomic: p.price_atomic,
    price_usdc: price,
    expires_at: new Date(p.expires_at).toISOString(),
    created_at: new Date(p.created_at).toISOString(),
    payer: p.payer,
    context: p.context,
    report: r,
    evidence: p.evidence,
    error: p.error,
    limitations: [...p.context.limitations, ...(route?.note ? [route.note] : [])],
    payments_enabled: cfg.paymentsEnabled,
    say: sayFor[p.status] ?? "Research status unknown.",
    trading_note:
      "Research never places, approves or claims a Gemini order. Trades need their own approval.",
  };
}

/** Context-only result: nothing stored, nothing payable. */
function contextView(
  context: MarketContext,
  limitation: string | null,
  route: Route | null,
  cfg: ResearchConfig,
): View {
  const now = new Date().toISOString();
  const limitations = [...context.limitations, ...(limitation ? [limitation] : [])];
  return {
    quote_id: "",
    status: "context_only",
    provider: "QuickNode x402",
    ...routeInfo(route),
    network: cfg.network,
    network_label: "Arc Testnet",
    payment_asset: cfg.asset,
    pay_to: null,
    payment_model: "None: no paid research for this market",
    price_atomic: "0",
    price_usdc: formatUsdc(0n),
    expires_at: now,
    created_at: now,
    payer: null,
    context,
    report: null,
    evidence: null,
    error: null,
    limitations,
    payments_enabled: cfg.paymentsEnabled,
    say: `${contextSummary(context)} ${limitation ?? ""} Nothing was charged.`
      .replace(/\s+/g, " ")
      .trim(),
    trading_note:
      "Research never places, approves or claims a Gemini order. Trades need their own approval.",
  };
}

export function researchService(d: Deps) {
  const { store, cfg } = d;

  async function resolve(eventTicker: string, contractSymbol: string) {
    if (!ID.test(eventTicker) || !ID.test(contractSymbol))
      throw new ResearchError("BAD_INPUT", "Select a Gemini market first.");
    const raw = await d.market(eventTicker, contractSymbol).catch(() => null);
    if (!raw?.event)
      throw new ResearchError("MARKET_UNAVAILABLE", "The selected market could not be read.", 404);
    let identified;
    try {
      identified = identifyMarket(raw.event, raw.contract, eventTicker, contractSymbol);
    } catch (e) {
      if (e instanceof AssetError)
        throw new ResearchError(e.code, e.message, e.code === "NOT_CRYPTO" ? 400 : 422);
      throw e;
    }
    const context = await buildContext(identified.asset, identified.market, d.klines);
    const decision = chooseRoute(identified.asset, await d.networks().catch(() => null));
    return { context, decision };
  }

  return {
    async context(input: { eventTicker: string; contractSymbol: string }) {
      const { context, decision } = await resolve(input.eventTicker, input.contractSymbol);
      return contextView(
        context,
        decision.route
          ? `Paid ${decision.route.chain} network research is available with a voice session and on-screen approval.`
          : decision.limitation,
        decision.route,
        cfg,
      );
    },

    async quote(input: {
      sid: string;
      eventTicker: string;
      contractSymbol: string;
    }): Promise<View> {
      const { context, decision } = await resolve(input.eventTicker, input.contractSymbol);
      const route = decision.route;
      if (!route) return contextView(context, decision.limitation, null, cfg);
      const url = routeUrl(route);
      const body = routeBody(route);
      // Unpaid probe: fixed route URL and body, no credentials, no payment header.
      let res: Response;
      try {
        res = await d.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        return contextView(
          context,
          `QuickNode ${route.network} is unreachable right now, so no paid research is offered.`,
          route,
          cfg,
        );
      }
      const text = (await res.text()).slice(0, 512 * 1024);
      const base = {
        sid: input.sid,
        context,
        route_id: route.id,
        resource_url: url,
        idempotency_key: null,
        reserved_at: null,
        payer: null,
        error: null,
      };
      if (res.status === 200) {
        // Free response: show it, never charge.
        const { report, rpcError } = readRoute(route, text, new Date());
        const p = await store.insert({
          ...base,
          status: "free",
          expires_at: Date.now(),
          requirement: null,
          price_atomic: "0",
          report,
          evidence: {
            ...blankEvidence(),
            http_status: 200,
            rpc_error: rpcError,
            response_sha256: await sha256Hex(text),
          },
        });
        return purchaseView(p, cfg);
      }
      if (res.status !== 402)
        return contextView(
          context,
          `QuickNode ${route.network} returned HTTP ${res.status}, so no paid research is offered.`,
          route,
          cfg,
        );
      let requirement;
      try {
        const pr = parsePaymentRequired(res.headers.get("payment-required"), text);
        requirement = validateRequirement(
          selectLikeSdk(pr.accepts, cfg.network),
          cfg,
          pr.resourceUrl,
          url,
        );
      } catch (e) {
        if (e instanceof QuoteRejected)
          throw new ResearchError(e.code, e.message + " Nothing was paid.", 422);
        throw e;
      }
      const p = await store.insert({
        ...base,
        status: "quoted",
        expires_at: Date.now() + cfg.quoteTtlMs,
        requirement,
        price_atomic: requirement.amount,
        report: null,
        evidence: null,
      });
      return purchaseView(p, cfg);
    },

    async approve(input: {
      sid: string;
      quoteId: string;
      maxAtomic: string;
      idempotencyKey: string;
    }) {
      if (!cfg.paymentsEnabled)
        throw new ResearchError(
          "PAYMENTS_DISABLED",
          "Research payments are switched off. Nothing was paid.",
          403,
        );
      if (!store.io.durable)
        throw new ResearchError(
          "STORAGE_UNAVAILABLE",
          "Durable payment storage is not configured. Nothing was paid.",
          503,
        );
      if (!cfg.expectedSender)
        throw new ResearchError(
          "WALLET_NOT_CONFIGURED",
          "Research wallet is not configured. Nothing was paid.",
          503,
        );
      const wallet = await d.wallet();
      if (!wallet)
        throw new ResearchError(
          "WALLET_NOT_CONFIGURED",
          "Research wallet is not configured. Nothing was paid.",
          503,
        );
      if (wallet.address.toLowerCase() !== cfg.expectedSender)
        throw new ResearchError(
          "WALLET_MISMATCH",
          "Research wallet does not match the configured sender. Nothing was paid.",
          503,
        );

      const current = await store.get(input.quoteId, input.sid);
      if (current.price_atomic !== input.maxAtomic)
        throw new ResearchError(
          "PRICE_MISMATCH",
          "Approved amount does not match the quote. Nothing was paid.",
          409,
        );
      if (!current.requirement)
        throw new ResearchError("ALREADY_HANDLED", "This research needs no payment.", 409);
      const route = routeById(current.route_id);
      if (!route || routeUrl(route) !== current.resource_url)
        throw new ResearchError(
          "ROUTE_UNAVAILABLE",
          "This research route is no longer supported. Nothing was paid.",
          409,
        );

      const { replay, purchase } = await store.reserve(
        input.quoteId,
        input.sid,
        input.idempotencyKey,
        wallet.address,
        {
          perRequest: cfg.maxPerRequest,
          perSession: cfg.maxPerSession,
          perDay: cfg.maxPerDay,
        },
      );
      if (replay) return purchaseView(purchase, cfg);
      const id = purchase.id;

      let outcome;
      try {
        outcome = await runPaidRequest({
          cfg,
          key: wallet.key,
          quoted: purchase.requirement!,
          url: purchase.resource_url,
          body: routeBody(route),
          factory: d.sdk,
          beforeSend: async () => {
            if (!(await store.transition(id, ["reserved"], { status: "sending" })))
              throw new Error("Reservation lost");
          },
        });
      } catch {
        // Thrown before client.fetch started (SDK init or the sending transition): nothing was sent.
        const released = await store.transition(id, ["reserved"], {
          status: "failed",
          error: "Payment could not start. Nothing was paid.",
        });
        return purchaseView(released ?? (await store.get(id, input.sid)), cfg);
      }

      const observed = new Date();
      const ev: Evidence = { ...blankEvidence(), signed: outcome.signed, api_ms: outcome.apiMs };
      if (outcome.availableBefore !== null)
        ev.gateway_available_before = outcome.availableBefore.toString();
      if (outcome.availableAfter !== null)
        ev.gateway_available_after = outcome.availableAfter.toString();
      if (outcome.availableBefore !== null && outcome.availableAfter !== null)
        ev.gateway_deduction_atomic = (outcome.availableBefore - outcome.availableAfter).toString();

      let fields: Partial<Purchase>;
      const res = outcome.response;
      if (res) {
        ev.http_status = res.status;
        ev.response_sha256 = await sha256Hex(res.text);
        ev.request_id = res.headers.get("x-request-id") ?? res.headers.get("cf-ray") ?? null;
        const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
        ev.payment_response_present = Boolean(header);
        ev.payment_response = decodePaymentResponse(header);
      }
      if (!outcome.signed) {
        // No payment payload was ever created, so nothing can have been charged.
        if (res?.status === 200) {
          const { report, rpcError } = readRoute(route, res.text, observed);
          ev.rpc_error = rpcError;
          fields = { status: "free", report, evidence: ev, error: null };
        } else {
          fields = {
            status: "failed",
            evidence: ev,
            error:
              (outcome.error ?? `HTTP ${res?.status ?? "error"}`) +
              " — refused before signing. Nothing was paid.",
          };
        }
      } else if (res && res.status === 200) {
        const { report, rpcError } = readRoute(route, res.text, observed);
        ev.rpc_error = rpcError;
        fields = { status: "paid", report, evidence: ev, error: rpcError };
      } else {
        fields = {
          status: "unknown_pending",
          evidence: ev,
          error:
            (outcome.error ?? `HTTP ${res?.status}`) +
            " after signing. Payment may have been taken; it will not be retried.",
        };
      }
      const done = await store.transition(id, ["sending", "unknown_pending"], fields);
      return purchaseView(done ?? (await store.get(id, input.sid)), cfg);
    },

    async status(input: { sid: string; quoteId: string }) {
      return purchaseView(await store.get(input.quoteId, input.sid), cfg);
    },
  };
}

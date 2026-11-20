// QuickNode x402 crypto research service.
//   context: free, public: identify the exact Gemini market + asset, build verified market context.
//   quote:   session-bound: context + (when a paid route exists) an unpaid x402 quote.
//   approve: session-bound, UI-only: one paid request on the quote's fixed route.
// Never imports or calls the Gemini trade engine. Gemini is read only (public event + index data).
import type { Contract, GEvent } from "../gemini";
import { AssetError, identifyMarket } from "./asset";
import { formatUsdc, type ResearchConfig } from "./config";
import { buildContext, type KlineSource, type MarketContext } from "./context";
import { bodyAllowed, runDex } from "./dex";
import { TIMEFRAME_LABEL, timeframeForSeries, type Timeframe } from "./dex/volume";
import { runPaidSession, type SdkFactory } from "./paid-request";
import {
  chooseRoute,
  marketFor,
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
        research_measures: route.measures,
        quicknode_network: route.network,
        resource: resourceLabel(route),
      }
    : {
        route_id: null,
        research_chain: null,
        research_measures: null,
        quicknode_network: null,
        resource: null,
      };
}

const defaultTimeframe = (c: MarketContext): Timeframe =>
  timeframeForSeries(c.market.series ?? null, c.market.event_ticker);

/** The exact spoken offer. The call-confirm webhook checks the caller heard this text. */
export function offerText(asset: string, tf: Timeframe, calls: number, price: string) {
  return `Would you like real DEX buy and sell volume for ${asset} over the last ${TIMEFRAME_LABEL[tf]} from QuickNode? It uses up to ${calls} paid data calls, at most ${price} testnet USDC.`;
}

/** Client-safe projection. Never includes keys, signatures, payment headers or session JWTs. */
export function purchaseView(p: Purchase, cfg: ResearchConfig) {
  const route = routeById(p.route_id);
  const price = formatUsdc(p.price_atomic);
  const maxAtomic = p.max_atomic ?? p.price_atomic;
  const r = p.report;
  const tf = p.timeframe ?? defaultTimeframe(p.context);
  const asset = p.context.asset.symbol;
  const calls = p.evidence?.calls_signed ?? null;
  const sayFor: Record<string, string> = {
    quoted: offerText(asset, tf, p.calls_planned ?? 1, formatUsdc(maxAtomic)),
    free: (r ? r.headline + " " : "") + "QuickNode answered without charging.",
    expired: "That research quote expired. Nothing was paid.",
    reserved: "Research payment is starting.",
    sending: "Research payment is in progress.",
    paid:
      (r ? r.headline : "QuickNode was paid but the data could not be read.") +
      ` Paid ${price} testnet USDC${calls !== null ? ` for ${calls} data calls` : ""} through Circle Gateway; it settles in batches.` +
      (r ? " Buy and sell flow is context, not a price forecast." : ""),
    unknown_pending:
      "The research payment status is unknown. It will not be retried automatically.",
    failed: "Research did not complete. Nothing was paid.",
  };
  return {
    quote_id: p.id,
    status: p.status as Purchase["status"] | "context_only",
    provider: "QuickNode x402",
    ...routeInfo(route),
    timeframe: tf,
    calls_planned: p.calls_planned ?? null,
    max_price_usdc: formatUsdc(maxAtomic),
    per_call_usdc: p.requirement ? formatUsdc(p.requirement.amount) : null,
    network: p.requirement?.network ?? cfg.network,
    network_label: "Arc Testnet",
    payment_asset: cfg.asset,
    pay_to: p.requirement?.payTo ?? null,
    payment_model: "Circle Gateway nanopayment (batched), one per data call",
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
  timeframe?: Timeframe,
): View {
  const now = new Date().toISOString();
  const limitations = [...context.limitations, ...(limitation ? [limitation] : [])];
  return {
    quote_id: "",
    status: "context_only",
    provider: "QuickNode x402",
    ...routeInfo(route),
    timeframe: timeframe ?? defaultTimeframe(context),
    calls_planned: null,
    max_price_usdc: formatUsdc(0n),
    per_call_usdc: null,
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
    async context(input: { eventTicker: string; contractSymbol: string; timeframe?: Timeframe | undefined }) {
      const { context, decision } = await resolve(input.eventTicker, input.contractSymbol);
      return contextView(
        context,
        decision.route
          ? `Paid ${context.asset.symbol} DEX buy and sell volume (${decision.route.measures}) is available with your approval on the call.`
          : decision.limitation,
        decision.route,
        cfg,
        input.timeframe,
      );
    },

    async quote(input: {
      sid: string;
      eventTicker: string;
      contractSymbol: string;
      /** Requested window; defaults to the selected prediction's duration. */
      timeframe?: Timeframe | undefined;
    }): Promise<View> {
      const { context, decision } = await resolve(input.eventTicker, input.contractSymbol);
      const tf = input.timeframe ?? defaultTimeframe(context);
      const route = decision.route;
      if (!route) return contextView(context, decision.limitation, null, cfg, tf);
      const url = routeUrl(route);
      const body = routeBody(route);
      const maxCalls = marketFor(route).maxCalls(tf);
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
          tf,
        );
      }
      const text = (await res.text()).slice(0, 512 * 1024);
      if (res.status !== 402)
        return contextView(
          context,
          res.status === 200
            ? `QuickNode ${route.network} answered without a payment request, so no paid research was started.`
            : `QuickNode ${route.network} returned HTTP ${res.status}, so no paid research is offered.`,
          route,
          cfg,
          tf,
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
      // Estimate before approval: every planned call is one nanopayment at the quoted price.
      const total = BigInt(requirement.amount) * BigInt(maxCalls);
      if (total > cfg.maxPerRequest)
        return contextView(
          context,
          `The last ${TIMEFRAME_LABEL[tf]} of ${context.asset.symbol} needs up to ${maxCalls} paid calls (${formatUsdc(total)} USDC), above the ${formatUsdc(cfg.maxPerRequest)} USDC per-request cap. Try a shorter timeframe. Nothing was charged.`,
          route,
          cfg,
          tf,
        );
      const p = await store.insert({
        sid: input.sid,
        context,
        route_id: route.id,
        resource_url: url,
        idempotency_key: null,
        reserved_at: null,
        payer: null,
        error: null,
        status: "quoted",
        expires_at: Date.now() + cfg.quoteTtlMs,
        requirement,
        price_atomic: total.toString(),
        max_atomic: total.toString(),
        timeframe: tf,
        calls_planned: maxCalls,
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
      const tf = current.timeframe;
      const planned = current.calls_planned;
      if (
        !route ||
        routeUrl(route) !== current.resource_url ||
        !tf ||
        !planned ||
        planned !== marketFor(route).maxCalls(tf) ||
        BigInt(current.requirement.amount) * BigInt(planned) !== BigInt(current.price_atomic)
      )
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
        const market = marketFor(route);
        outcome = await runPaidSession({
          cfg,
          key: wallet.key,
          quoted: purchase.requirement!,
          url: purchase.resource_url,
          maxCalls: planned,
          allowBody: (body) => bodyAllowed(market, body),
          factory: d.sdk,
          beforeSend: async () => {
            if (!(await store.transition(id, ["reserved"], { status: "sending" })))
              throw new Error("Reservation lost");
          },
          work: (send) => runDex(market, tf, send),
        });
      } catch {
        // Thrown before any request started (SDK init or the sending transition): nothing was sent.
        const released = await store.transition(id, ["reserved"], {
          status: "failed",
          error: "Payment could not start. Nothing was paid.",
        });
        return purchaseView(released ?? (await store.get(id, input.sid)), cfg);
      }

      const ev: Evidence = {
        ...blankEvidence(),
        signed: outcome.signed,
        api_ms: outcome.apiMs,
        calls_sent: outcome.callsSent,
        calls_ok: outcome.callsOk,
        calls_signed: outcome.signedCount,
        response_sha256: outcome.responsesSha256,
      };
      if (outcome.availableBefore !== null)
        ev.gateway_available_before = outcome.availableBefore.toString();
      if (outcome.availableAfter !== null)
        ev.gateway_available_after = outcome.availableAfter.toString();
      if (outcome.availableBefore !== null && outcome.availableAfter !== null)
        ev.gateway_deduction_atomic = (outcome.availableBefore - outcome.availableAfter).toString();
      const res = outcome.response;
      if (res) {
        ev.http_status = res.status;
        ev.request_id = res.headers.get("x-request-id") ?? res.headers.get("cf-ray") ?? null;
        const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
        ev.payment_response_present = Boolean(header);
        ev.payment_response = decodePaymentResponse(header);
      }
      const report = outcome.result?.report ?? null;
      if (report && report.completeness !== "complete" && report.warnings.length)
        ev.rpc_error = report.warnings.find((w) => /unavailable|failed|error|HTTP/i.test(w)) ?? null;
      // Budget actually held: every created payment may have been charged.
      const spent = (BigInt(purchase.requirement!.amount) * BigInt(outcome.signedCount)).toString();
      const uncertain =
        outcome.signedCount > outcome.callsOk
          ? ` ${outcome.signedCount - outcome.callsOk} paid call(s) did not return data; payment for them may still have been taken. Nothing is retried.`
          : "";

      let fields: Partial<Purchase>;
      if (!outcome.signed) {
        // No payment payload was ever created, so nothing can have been charged.
        fields =
          outcome.callsOk > 0 && report
            ? { status: "free", report, evidence: ev, price_atomic: "0", error: null }
            : {
                status: "failed",
                evidence: ev,
                price_atomic: "0",
                error:
                  (outcome.error ?? `HTTP ${res?.status ?? "error"}`) +
                  " — refused before signing. Nothing was paid.",
              };
      } else if (outcome.callsOk > 0 && report) {
        fields = {
          status: "paid",
          report,
          evidence: ev,
          price_atomic: spent,
          error: uncertain ? uncertain.trim() : null,
        };
      } else {
        // Signed but no data at all: keep holding the full approved budget.
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

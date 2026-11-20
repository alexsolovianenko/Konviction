// Browser side of Konviction crypto research (paid part: DEX buy vs sell volume). When the user selects any Gemini crypto contract the
// client automatically asks the server to identify the exact market and its asset and to build free
// context; with a voice session it also gets an unpaid QuickNode x402 quote when a paid route exists.
// The voice agent gets two READ-ONLY tools. No tool can spend: payment starts only from the
// on-screen approval button. The session bearer stays in browser memory, never in the model.

export type Timeframe = "5m" | "15m" | "1h" | "24h";
export const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "24h"];
export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "5m": "5 minutes",
  "15m": "15 minutes",
  "1h": "1 hour",
  "24h": "24 hours",
};
/** DEX buy vs sell volume for one asset over a measured window (server: dex/report.ts). */
export type ResearchReport = {
  kind: "dex_volume";
  asset: string;
  asset_note: string | null;
  chain: string;
  source: string;
  method: string;
  timeframe: Timeframe;
  requested_seconds: number;
  measured_from: string | null;
  measured_to: string | null;
  measured_seconds: number;
  completeness: "complete" | "partial" | "unavailable";
  buy_usd: number | null;
  sell_usd: number | null;
  net_buy_usd: number | null;
  buy_pct: number | null;
  trade_count: number | null;
  pool_tx_count: number | null;
  last_trade_at: string | null;
  pools: Array<{ dex: string; pair: string; address: string; url: string }>;
  coverage: string;
  examples: Array<{ hash: string; side: "buy" | "sell"; usd: number; at: string; url: string }>;
  calls_used: number;
  headline: string;
  observed_at: string;
  warnings: string[];
  disclaimer: string;
};
export type MarketContext = {
  asset: { symbol: string; name: string | null; identified_from: string[] };
  market: {
    event_ticker: string;
    series?: string | null;
    contract_symbol: string;
    title: string | null;
    contract_label: string | null;
    strike_type: string | null;
    strike: string | null;
    expiry: string | null;
    settlement_agency: string | null;
    settlement_index: string | null;
    prices: {
      yes_buy: number | null;
      no_buy: number | null;
      yes_sell: number | null;
      no_sell: number | null;
    };
  };
  implied_yes_pct: number | null;
  spread: number | null;
  spot: {
    source: string;
    last: number;
    as_of: string;
    change_60m_pct: number | null;
    realized_vol_60m_pct: number | null;
    high_60m: number;
    low_60m: number;
    minutes: number;
    distance_to_strike_pct: number | null;
  } | null;
  limitations: string[];
};
export type ResearchEvidence = {
  http_status: number | null;
  rpc_error: string | null;
  request_id: string | null;
  api_ms: number | null;
  payment_response: Record<string, string | boolean | null> | null;
  payment_response_present: boolean;
  signed: boolean;
  gateway_available_before: string | null;
  gateway_available_after: string | null;
  gateway_deduction_atomic: string | null;
  response_sha256: string | null;
  calls_sent?: number;
  calls_ok?: number;
  calls_signed?: number;
};
export type ResearchQuote = {
  quote_id: string;
  status:
    | "context_only"
    | "quoted"
    | "free"
    | "expired"
    | "reserved"
    | "sending"
    | "paid"
    | "unknown_pending"
    | "failed";
  provider: string;
  route_id: string | null;
  research_chain: string | null;
  research_measures?: string | null;
  timeframe?: Timeframe;
  calls_planned?: number | null;
  max_price_usdc?: string;
  per_call_usdc?: string | null;
  quicknode_network: string | null;
  resource: string | null;
  network: string;
  network_label: string;
  payment_asset: string;
  pay_to: string | null;
  payment_model: string;
  price_atomic: string;
  price_usdc: string;
  expires_at: string;
  created_at: string;
  payer: string | null;
  context: MarketContext;
  report: ResearchReport | null;
  evidence: ResearchEvidence | null;
  error: string | null;
  limitations: string[];
  payments_enabled: boolean;
  say: string;
  trading_note: string;
};
export type ResearchView = {
  quote: ResearchQuote | null;
  busy: boolean;
  message: string;
  canApprove: boolean;
  /** Free context shown, a paid route exists and a voice session can fetch its unpaid quote. */
  canQuote: boolean;
};
export const initialResearch: ResearchView = {
  quote: null,
  busy: false,
  message: "",
  canApprove: false,
  canQuote: false,
};

type Json = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  message?: string;
  say?: string;
};
type Target = { event_ticker: string; contract_symbol: string };
const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === "string" && (TIMEFRAMES as string[]).includes(v);

async function call(
  action: "context" | "quote" | "status",
  body: unknown,
  token: string | null,
): Promise<Json> {
  try {
    const res = await fetch("/api/public/quicknode-research/" + action, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: "Bearer " + token }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return (await res.json()) as Json;
  } catch {
    return {
      ok: false,
      error: "NETWORK",
      message: "Research unavailable.",
      say: "Research is unavailable right now.",
    };
  }
}

/** Client-safe grounded facts for the voice agent. No ids, addresses, hashes, tokens or signatures. */
export function agentSummary(q: ResearchQuote) {
  const c = q.context;
  const r = q.report;
  return {
    status: q.status,
    asset: `${c.asset.name ?? c.asset.symbol} (${c.asset.symbol})`,
    market: [c.market.title, c.market.contract_label].filter(Boolean).join(" · "),
    expiry: c.market.expiry,
    // Free Gemini context: settlement index, strike, expiry and YES/NO prices.
    settlement_index: c.market.settlement_index ?? null,
    strike: c.market.strike ?? null,
    yes_buy: c.market.prices?.yes_buy ?? null,
    no_buy: c.market.prices?.no_buy ?? null,
    implied_yes_pct: c.implied_yes_pct,
    settlement_index_last: c.spot?.last ?? null,
    distance_to_strike_pct: c.spot?.distance_to_strike_pct ?? null,
    paid_research: q.research_measures
      ? `DEX buy and sell volume from ${q.research_measures}, via QuickNode`
      : "not available for this asset",
    timeframe: q.timeframe ? TIMEFRAME_LABEL[q.timeframe] : null,
    available_timeframes: q.route_id ? TIMEFRAMES.map((t) => TIMEFRAME_LABEL[t]) : [],
    price_usdc: q.status === "context_only" ? null : q.price_usdc,
    paid: q.status === "paid",
    dex_volume: r
      ? {
          completeness: r.completeness,
          measured: r.measured_seconds ? `${r.measured_seconds} seconds` : null,
          buy_usd: r.buy_usd,
          sell_usd: r.sell_usd,
          net_buy_usd: r.net_buy_usd,
          buy_pct: r.buy_pct,
          trades: r.trade_count,
          headline: r.headline,
          coverage: r.coverage,
          warnings: r.warnings,
        }
      : null,
    limitations: q.limitations,
    say: q.say,
    caveat:
      "Executed DEX buy/sell flow and Gemini market context only. Not a price forecast or trading advice. No order was placed.",
  };
}

export class ResearchClient {
  private view: ResearchView = initialResearch;
  private selection = 0;
  constructor(
    private publish: (v: ResearchView) => void,
    private token: () => string | null,
    private visible: () => Target | null,
  ) {}

  private set(patch: Partial<ResearchView>) {
    const v = { ...this.view, ...patch };
    const q = v.quote;
    v.canApprove = Boolean(
      q &&
      q.status === "quoted" &&
      q.payments_enabled &&
      Date.parse(q.expires_at) > Date.now() &&
      this.token(),
    );
    v.canQuote = Boolean(q && q.status === "context_only" && q.route_id && this.token() && !v.busy);
    this.view = v;
    this.publish(v);
  }

  private matches(q: ResearchQuote | null, t: Target | null) {
    return Boolean(
      q &&
      t &&
      q.context.market.event_ticker === t.event_ticker &&
      q.context.market.contract_symbol === t.contract_symbol,
    );
  }

  /**
   * "context": free, public, no session token, nothing stored (automatic on selection).
   * "quote": session-bound unpaid quote (only on request: voice tool or on-screen button).
   */
  private async load(target: Target, mode: "context" | "quote", timeframe?: Timeframe) {
    const id = ++this.selection;
    const token = mode === "quote" ? this.token() : null;
    if (mode === "quote" && !token)
      return { ok: false, say: "Start voice to get a paid research price." } as Json;
    this.set({
      quote: mode === "quote" ? this.view.quote : null,
      busy: true,
      message: mode === "quote" ? "Getting a research price…" : "Identifying the market…",
    });
    const r = await call(mode, timeframe ? { ...target, timeframe } : target, token);
    if (id !== this.selection) return null; // a newer selection superseded this one
    const shaped =
      r.ok &&
      (r as unknown as Partial<ResearchQuote>).context?.market?.event_ticker ===
        target.event_ticker;
    if (r.ok && !shaped) {
      this.set({ busy: false, message: "Research unavailable." });
      return { ok: false, say: "Research is unavailable right now." } as Json;
    }
    if (!r.ok) {
      // Non-crypto markets simply have no research card.
      this.set({
        busy: false,
        message: r.error === "NOT_CRYPTO" ? "" : (r.message ?? "Research unavailable."),
      });
      return r;
    }
    const quote = r as unknown as ResearchQuote;
    this.set({
      busy: false,
      quote,
      message:
        quote.status === "quoted" && !quote.payments_enabled
          ? "Research payments are switched off on this server."
          : "",
    });
    return r;
  }

  /** Called whenever the on-screen contract changes. Free; never pays. */
  select(target: Target | null) {
    if (!target) {
      this.selection++;
      this.set({ quote: null, busy: false, message: "" });
      return;
    }
    if (this.matches(this.view.quote, target)) return;
    void this.load(target, "context");
  }

  /** On-screen "get paid research price" button. Unpaid; never spends. */
  async requestQuote() {
    const target = this.visible();
    const q = this.view.quote;
    if (
      target &&
      q &&
      this.matches(q, target) &&
      q.status === "context_only" &&
      q.route_id &&
      this.token() &&
      !this.view.busy
    )
      await this.load(target, "quote");
  }

  /** Voice tools. Neither can spend, and neither accepts a URL, method or RPC body. */
  tools(current: () => boolean) {
    return {
      request_research_quote: async (params?: Record<string, unknown>) => {
        if (!current()) return JSON.stringify({ ok: false, say: "Session ended." });
        const target = this.visible();
        if (!target) return JSON.stringify({ ok: false, say: "Pick a crypto prediction first." });
        const raw = params?.["timeframe"];
        if (raw !== undefined && raw !== null && raw !== "" && !isTimeframe(raw))
          return JSON.stringify({
            ok: false,
            say: "Research covers 5 minutes, 15 minutes, 1 hour or 24 hours.",
            next_action: "wait_for_user",
          });
        const timeframe = isTimeframe(raw) ? raw : undefined;
        const existing = this.view.quote;
        // Reuse a fresh session-bound result for this exact contract and timeframe; otherwise (re)load.
        const fresh =
          existing &&
          this.matches(existing, target) &&
          (!timeframe || existing.timeframe === timeframe) &&
          (existing.status !== "quoted" || Date.parse(existing.expires_at) > Date.now());
        // Upgrade free context to a session-bound unpaid quote only when a paid route exists.
        const wantsQuote =
          !fresh || (existing.status === "context_only" && existing.route_id && this.token());
        const r = !wantsQuote
          ? { ok: true }
          : await this.load(target, fresh || this.token() ? "quote" : "context", timeframe);
        const quote = this.view.quote;
        if (!r?.ok || !quote)
          return JSON.stringify({
            ok: false,
            error: r?.error,
            say: r?.say ?? r?.message ?? "Research unavailable.",
            next_action: "wait_for_user",
          });
        return JSON.stringify({
          ok: true,
          ...agentSummary(quote),
          say:
            quote.status === "quoted" && !quote.payments_enabled
              ? "Research payments are switched off right now."
              : quote.say,
          ...(quote.status === "quoted" && quote.payments_enabled && {quote_id: quote.quote_id}),
          next_action: quote.status === "quoted" && quote.payments_enabled ? "ask_for_voice_approval" : "report_result",
        });
      },
      get_research_result: async () => {
        if (!current()) return JSON.stringify({ ok: false, say: "Session ended." });
        const token = this.token();
        if (!this.view.quote)
          return JSON.stringify({ ok: false, say: "No research requested yet." });
        const q =
          (token && this.view.quote.quote_id ? await this.refresh(token) : null) ?? this.view.quote;
        return JSON.stringify({ ok: true, ...agentSummary(q) });
      },
    };
  }

  private async refresh(token: string) {
    const q = this.view.quote;
    if (!q?.quote_id) return null;
    const r = await call("status", { quote_id: q.quote_id }, token);
    if (!r.ok) return null;
    const next = r as unknown as ResearchQuote;
    if (this.view.quote?.quote_id === next.quote_id) this.set({ quote: next });
    return next;
  }
}

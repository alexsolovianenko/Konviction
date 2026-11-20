// Browser side of Arc research. The voice agent gets two read-only tools: ask for a quote and read
// the result. It has no tool that spends: payment starts only from the on-screen approval button.
// The session bearer stays in browser memory and is never passed to the language model.

export type ResearchRow = {
  market: {
    venue: string;
    id: string;
    title: string;
    strike: number | null;
    expiry: string | null;
    settlement: string | null;
    yesAsk: number | null;
    yesBid: number | null;
    volume: number | null;
    url: string | null;
  };
  match: "same_strike_same_expiry" | "nearby_strike" | "different_structure" | "different_expiry";
  differences: string[];
  strikeDiff: number | null;
  expiryDiffMinutes: number | null;
  priceGapCents: number | null;
};
export type ResearchQuote = {
  quote_id: string;
  status: string;
  provider: string;
  endpoint: string;
  query: string;
  price_atomic: string;
  price_usd: string;
  network: string;
  pay_to: string;
  payer: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  block_number: number | null;
  expires_at: string;
  error: string | null;
  payments_enabled?: boolean;
  gemini: {
    eventTicker: string;
    title: string;
    contractLabel: string;
    strike: number | null;
    expiry: string | null;
    settlement: string | null;
    yesAsk: number | null;
    yesBid: number | null;
    feePerContractEst: number | null;
  };
  comparison?: {
    markets_found: number;
    rows: ResearchRow[];
    summary: string;
    disclaimer: string;
  } | null;
  say?: string;
};
export type ResearchView = {
  quote: ResearchQuote | null;
  busy: boolean;
  message: string;
  canApprove: boolean;
};

type Json = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  message?: string;
  say?: string;
};

async function call(action: string, body: unknown, token: string): Promise<Json> {
  try {
    const res = await fetch("/api/public/arc-research/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
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

const FINAL = ["settled_onchain", "failed", "expired", "free_no_match"];

export class ResearchClient {
  private view: ResearchView = { quote: null, busy: false, message: "", canApprove: false };
  private approving = false;
  constructor(
    private publish: (v: ResearchView) => void,
    private token: () => string | null,
    private visible: () => { event_ticker: string; contract_symbol: string } | null,
    private tellAgent: (text: string) => void,
  ) {}

  private set(patch: Partial<ResearchView>) {
    this.view = { ...this.view, ...patch };
    const q = this.view.quote;
    this.view.canApprove = Boolean(
      q &&
      q.status === "quoted" &&
      q.payments_enabled !== false &&
      Date.parse(q.expires_at) > Date.now() &&
      this.token(),
    );
    this.publish(this.view);
  }

  /** Voice tools. Neither one can spend. */
  tools(current: () => boolean) {
    return {
      request_research_quote: async (params: Record<string, unknown>) => {
        if (!current()) return JSON.stringify({ ok: false, say: "Session ended." });
        const token = this.token();
        if (!token) return JSON.stringify({ ok: false, say: "Restart voice to use research." });
        const target =
          typeof params["event_ticker"] === "string" && params["event_ticker"]
            ? {
                event_ticker: String(params["event_ticker"]),
                contract_symbol: String(params["contract_symbol"] ?? ""),
              }
            : this.visible();
        if (!target) return JSON.stringify({ ok: false, say: "Pick a market first." });
        this.set({ busy: true, message: "Getting a research price…" });
        const r = await call("quote", target, token);
        if (!r.ok) {
          this.set({ busy: false, message: r.message ?? "Research unavailable." });
          return JSON.stringify({
            ok: false,
            say: r.say ?? r.message,
            next_action: "wait_for_user",
          });
        }
        const quote = r as unknown as ResearchQuote;
        this.set({
          busy: false,
          quote,
          message:
            quote.payments_enabled === false
              ? "Research payments are switched off on this server."
              : "",
        });
        return JSON.stringify({
          ok: true,
          price_usd: quote.price_usd,
          network: "Arc",
          provider: quote.provider,
          say:
            quote.payments_enabled === false
              ? "Research payments are switched off right now, so I can't buy the comparison."
              : quote.say,
          next_action: "wait_for_on_screen_approval",
        });
      },
      get_research_result: async () => {
        if (!current()) return JSON.stringify({ ok: false, say: "Session ended." });
        const q = this.view.quote;
        const token = this.token();
        if (!q || !token) return JSON.stringify({ ok: false, say: "No research requested yet." });
        const r = await this.refresh(token);
        return JSON.stringify({
          ok: Boolean(r),
          status: r?.status ?? q.status,
          say: r?.say ?? "Research status unknown.",
          rows:
            r?.comparison?.rows.slice(0, 3).map((x) => ({
              venue: x.market.venue,
              title: x.market.title,
              match: x.match,
              yes_ask: x.market.yesAsk,
              differences: x.differences,
            })) ?? [],
        });
      },
    };
  }

  private async refresh(token: string) {
    const q = this.view.quote;
    if (!q) return null;
    const r = await call("status", { quote_id: q.quote_id }, token);
    if (r.ok) this.set({ quote: r as unknown as ResearchQuote, message: "" });
    return r.ok ? (r as unknown as ResearchQuote) : null;
  }

  /** On-screen button only. */
  async approve() {
    const q = this.view.quote;
    const token = this.token();
    if (!q || !token || this.approving || !this.view.canApprove) return;
    this.approving = true;
    this.set({ busy: true, message: "Paying on Arc…" });
    try {
      const r = await call(
        "approve",
        { quote_id: q.quote_id, max_atomic: q.price_atomic, confirm: "APPROVE_RESEARCH_PAYMENT" },
        token,
      );
      if (!r.ok) {
        this.set({
          busy: false,
          message: r.message ?? "Research payment refused. Nothing was paid.",
        });
        return;
      }
      let latest = r as unknown as ResearchQuote;
      this.set({ quote: latest });
      for (let i = 0; i < 20 && !FINAL.includes(latest.status); i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const t = this.token();
        if (!t) break;
        latest = (await this.refresh(t)) ?? latest;
      }
      this.set({ busy: false });
      if (latest.say)
        this.tellAgent(
          "Research result (on screen; summarize honestly, do not trade unless the user separately asks): " +
            latest.say,
        );
    } finally {
      this.approving = false;
    }
  }
}

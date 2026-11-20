import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchCard } from "./ResearchCard";
import { agentSummary, ResearchClient, type ResearchQuote } from "../../quicknodeResearch";

const context = (symbol = "BTC", name = "Bitcoin"): ResearchQuote["context"] => ({
  asset: { symbol, name, identified_from: ["contract_rules", "title", "event_ticker", "series"] },
  market: {
    event_ticker: `${symbol}2611202300`,
    contract_symbol: `GEMI-${symbol}2611202300-HI61600`,
    title: `${symbol} price today at 10pm EST`,
    contract_label: "$61,600 or above",
    strike_type: "above",
    strike: "61600",
    expiry: "2026-11-21T04:00:00.000Z",
    settlement_agency: "lukka",
    settlement_index: "LS-LRRR-XBTUSD",
    prices: { yes_buy: 0.6, no_buy: 0.42, yes_sell: 0.58, no_sell: 0.4 },
  },
  implied_yes_pct: 60,
  spread: 0.02,
  spot: {
    source: "Gemini Sandbox settlement index lukka LS-LRRR-XBTUSD",
    last: 61838.84,
    as_of: "2026-11-20T09:00:00.000Z",
    change_60m_pct: 0.12,
    realized_vol_60m_pct: 0.376,
    high_60m: 61900,
    low_60m: 61700,
    minutes: 60,
    distance_to_strike_pct: -0.39,
  },
  limitations: [],
});

const quote = (over: Partial<ResearchQuote> = {}): ResearchQuote => ({
  quote_id: "q1",
  status: "quoted",
  provider: "QuickNode x402",
  route_id: "btc",
  research_chain: "Bitcoin",
  quicknode_network: "btc-mainnet",
  resource: "btc-mainnet · getmempoolinfo",
  network: "eip155:5042002",
  network_label: "Arc Testnet",
  payment_asset: "0x3600000000000000000000000000000000000000",
  pay_to: "0xF46394adDdA95A3d5bCC1124605E3d15D204623C",
  payment_model: "Circle Gateway nanopayment (batched)",
  price_atomic: "100",
  price_usdc: "0.0001",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  created_at: new Date().toISOString(),
  payer: null,
  context: context(),
  report: null,
  evidence: null,
  error: null,
  limitations: [],
  payments_enabled: true,
  say: "costs 0.0001",
  trading_note: "",
  ...over,
});

const paid = () =>
  quote({
    status: "paid",
    report: {
      family: "utxo",
      chain: "Bitcoin",
      method: "getmempoolinfo",
      comparison: null,
      coverage: "Current mempool snapshot",
      metrics: [{ label: "Pending transactions", value: 12345, unit: "tx" }],
      headline:
        "Bitcoin mempool currently holds 12,345 pending transactions. That is network congestion, not a price signal.",
      observed_at: "2026-11-20T09:00:00Z",
      warnings: [],
      disclaimer: "Not a price prediction.",
    },
    evidence: {
      http_status: 200,
      rpc_error: null,
      request_id: "req-1",
      api_ms: 812,
      payment_response: { success: true, provider_reference: "gw-ref" },
      payment_response_present: true,
      signed: true,
      gateway_available_before: "1000000",
      gateway_available_after: "999900",
      gateway_deduction_atomic: "100",
      response_sha256: "ab".repeat(32),
    },
  });

afterEach(() => vi.restoreAllMocks());

describe("ResearchCard", () => {
  it("shows the identified asset, market context and the exact cost on a separate approval button", () => {
    const onApprove = vi.fn();
    const { container } = render(
      <ResearchCard
        research={{ quote: quote(), busy: false, message: "", canApprove: true, canQuote: false }}
        onApprove={onApprove}
      />,
    );
    expect(screen.getByRole("heading", { name: "Bitcoin (BTC) research" })).toBeTruthy();
    expect(container.textContent).toMatch(/implied YES 60%/);
    expect(container.textContent).toMatch(/LS-LRRR-XBTUSD/);
    expect(screen.getByText("-0.39%")).toBeTruthy();
    screen
      .getByRole("button", { name: "Approve 0.0001 testnet USDC for Bitcoin research" })
      .click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(screen.getByText(/never places or approves a Gemini order/)).toBeTruthy();
  });
  it("context-only shows the limitation and no payment button", () => {
    const q = quote({
      status: "context_only",
      quote_id: "",
      route_id: null,
      research_chain: null,
      context: context("FOO", "Foocoin"),
      limitations: ["No supported paid QuickNode x402 research source for Foocoin (FOO)."],
    });
    const { container } = render(
      <ResearchCard
        research={{ quote: q, busy: false, message: "", canApprove: false, canQuote: false }}
        onApprove={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Foocoin (FOO) research" })).toBeTruthy();
    expect(container.textContent).toMatch(
      /No supported paid QuickNode x402 research source for Foocoin/,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).not.toMatch(/Payment evidence/);
  });
  it("shows paid results and honest payment evidence without settlement claims", () => {
    const { container } = render(
      <ResearchCard
        research={{ quote: paid(), busy: false, message: "", canApprove: false, canQuote: false }}
        onApprove={() => {}}
      />,
    );
    expect(screen.getByText("12,345 tx")).toBeTruthy();
    expect(container.textContent).toMatch(/observed deduction 0\.0001 USDC/);
    expect(container.textContent).toMatch(/no per-request on-chain transaction is claimed/);
    expect(container.textContent).not.toMatch(/settled on-?chain|order (placed|filled)/i);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ResearchClient", () => {
  const target = { event_ticker: "BTC2611202300", contract_symbol: "GEMI-BTC2611202300-HI61600" };
  it("automatically researches a newly selected market: free context without a session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, ...quote({ status: "context_only", quote_id: "" }) }),
        ),
      );
    const views: unknown[] = [];
    const client = new ResearchClient(
      (v) => views.push(v),
      () => null,
      () => target,
      () => {},
    );
    client.select(target);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/public/quicknode-research/context");
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBeNull();
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(target);
    await vi.waitFor(() =>
      expect((views.at(-1) as { quote: ResearchQuote | null }).quote?.status).toBe("context_only"),
    );
  });
  it("selection never sends the session token; the read-only tool upgrades to an unpaid quote only on request", async () => {
    const contextOnly = quote({ status: "context_only", quote_id: "", price_atomic: "0" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify({
            ok: true,
            ...(String(url).endsWith("/context") ? contextOnly : quote()),
          }),
        ),
    );
    const views: Array<{ quote: ResearchQuote | null; canQuote: boolean }> = [];
    const client = new ResearchClient(
      (v) => views.push(v),
      () => "token",
      () => target,
      () => {},
    );
    client.select(target);
    await vi.waitFor(() => expect(views.at(-1)?.quote?.status).toBe("context_only"));
    expect(views.at(-1)?.canQuote).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/public/quicknode-research/context");
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBeNull();
    const tools = client.tools(() => true);
    expect(Object.keys(tools).sort()).toEqual(["get_research_result", "request_research_quote"]);
    const out = await tools.request_research_quote();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/public/quicknode-research/quote");
    expect(out).not.toMatch(/token|0x[0-9a-fA-F]{8}|quote_id|GEMI-/);
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      asset: "Bitcoin (BTC)",
      price_usdc: "0.0001",
      implied_yes_pct: 60,
      next_action: "wait_for_on_screen_approval",
    });
    await tools.request_research_quote(); // reuses the fresh quote for this exact contract
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(agentSummary(paid()))).not.toMatch(/0x|gw-ref|ab{4}/);
  });
  it("ignores a malformed research response instead of crashing the panel", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, event_ticker: "E" })),
    );
    const views: Array<{ quote: unknown; message: string }> = [];
    const client = new ResearchClient(
      (v) => views.push(v),
      () => null,
      () => target,
      () => {},
    );
    client.select(target);
    await vi.waitFor(() =>
      expect(views.at(-1)).toMatchObject({ quote: null, message: "Research unavailable." }),
    );
  });
  it("offers an unpaid price button for a routable context-only market", () => {
    const onRequestQuote = vi.fn();
    const q = quote({ status: "context_only", quote_id: "", price_atomic: "0" });
    render(
      <ResearchCard
        research={{ quote: q, busy: false, message: "", canApprove: false, canQuote: true }}
        onApprove={() => {}}
        onRequestQuote={onRequestQuote}
      />,
    );
    screen.getByRole("button", { name: "Get paid Bitcoin research price" }).click();
    expect(onRequestQuote).toHaveBeenCalledOnce();
  });
  it("non-crypto selections show no card", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "NOT_CRYPTO", message: "crypto only" })),
    );
    const views: Array<{ quote: unknown; message: string }> = [];
    const client = new ResearchClient(
      (v) => views.push(v),
      () => null,
      () => target,
      () => {},
    );
    client.select(target);
    await vi.waitFor(() => expect(views.at(-1)).toMatchObject({ quote: null, message: "" }));
  });
});

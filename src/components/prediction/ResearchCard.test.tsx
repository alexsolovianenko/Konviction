import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResearchCard } from "./ResearchCard";
import type { ResearchQuote } from "../../research";

const quote = (over: Partial<ResearchQuote> = {}): ResearchQuote => ({
  quote_id: "q1",
  status: "quoted",
  provider: "BlockRun (Predexon data)",
  endpoint: "/api/v1/pm/markets/search",
  query: "bitcoin",
  price_atomic: "8500",
  price_usd: "$0.0085",
  network: "eip155:5042",
  pay_to: "0x634D",
  payer: null,
  tx_hash: null,
  explorer_url: null,
  block_number: null,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  error: null,
  payments_enabled: true,
  gemini: {
    eventTicker: "BTC2611192200",
    title: "BTC price on November 19",
    contractLabel: "$61,750 or above",
    strike: 61750,
    expiry: null,
    settlement: "lukka LS-LRRR-XBTUSD",
    yesAsk: 0.98,
    yesBid: 0.95,
    feePerContractEst: 0.0014,
  },
  ...over,
});

describe("ResearchCard", () => {
  it("shows the price and a separate approval button", () => {
    const onApprove = vi.fn();
    render(
      <ResearchCard
        research={{ quote: quote(), busy: false, message: "", canApprove: true }}
        onApprove={onApprove}
      />,
    );
    screen.getByRole("button", { name: /Approve research, max \$0.0085/ }).click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(screen.getByText(/Orders need separate approval/)).toBeTruthy();
  });
  it("shows settlement proof and labelled differences, never 'identical'", () => {
    const q = quote({
      status: "settled_onchain",
      tx_hash: "0x" + "ab".repeat(32),
      explorer_url: "https://explorer.arc.io/tx/0xab",
      comparison: {
        markets_found: 3,
        summary: "Kalshi has the same strike and expiry.",
        disclaimer: "x",
        rows: [
          {
            market: {
              venue: "kalshi",
              id: "KXBTCD-26NOV1917-T61749.99",
              title: "$61,750 or above",
              strike: 61749.99,
              expiry: null,
              settlement: "CF",
              yesAsk: 0.36,
              yesBid: 0.35,
              volume: 311888,
              url: null,
            },
            match: "same_strike_same_expiry",
            differences: ["Settles to CF Benchmarks index; Gemini settles to Lukka index."],
            strikeDiff: -0.01,
            expiryDiffMinutes: 0,
            priceGapCents: 62,
          },
        ],
      },
    });
    const { container } = render(
      <ResearchCard
        research={{ quote: q, busy: false, message: "", canApprove: false }}
        onApprove={() => {}}
      />,
    );
    expect(screen.getByText(/USDC transfer verified/)).toBeTruthy();
    expect(screen.getByText("Same strike & expiry")).toBeTruthy();
    expect(container.textContent).toMatch(/CF Benchmarks/);
    expect(container.textContent).not.toMatch(/identical/i);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

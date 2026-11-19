import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverviewView } from "./Console";
import { tradingRequest } from "../../browserTrading";

const { feed } = vi.hoisted(() => ({ feed: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: feed }));
vi.mock("../../browserTrading", () => ({ workerTrading: true, tradingRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("loads exchange fills even when the journal is offline and open positions are empty", async () => {
  feed.mockReturnValue({ data: {
    account: { configured: true, usd_available: 10, terms_accepted: true, positions: [], positions_error: null },
    limits: { maxOrderUsd: 25, maxDailyUsd: 50, maxLimitPrice: .95 },
    history_available: false, activity: [], intents: [], orders: [], receipts: [],
  } });
  vi.mocked(tradingRequest).mockResolvedValueOnce({
    ok: true, as_of: new Date().toISOString(), orders: { rows: [] }, positions: { rows: [] },
    history: { rows: [{ symbol: "GEMI-TEST", filledQuantity: "1" }] },
  });
  render(<OverviewView />);
  expect(screen.getByText("Gemini reports no open positions.")).toBeInTheDocument();
  expect(screen.queryByText("No trades yet.")).toBeNull();
  expect(screen.queryByLabelText("Approval PIN")).toBeNull();
  expect(await screen.findByText("GEMI-TEST")).toBeInTheDocument();
  expect(tradingRequest).toHaveBeenCalledWith("portfolio", {});
});

it("reports an unavailable portfolio feed", async () => {
  feed.mockReturnValue({ isError: true, error: new Error("offline") });
  vi.mocked(tradingRequest).mockResolvedValueOnce({ ok: false, message: "Order history unavailable." });
  render(<OverviewView />);
  expect(await screen.findByText("Order history unavailable.")).toBeVisible();
  expect(screen.queryByLabelText("Sandbox PIN")).toBeNull();
});

it("opens the hosted account using the private portfolio endpoint", async () => {
  feed.mockReturnValue({ data: { account: { configured: false }, history_available: false, activity: [], intents: [], orders: [], receipts: [] } });
  vi.mocked(tradingRequest).mockResolvedValueOnce({
    ok: true, usd_available: 123.45, as_of: new Date().toISOString(),
    orders: { rows: [] }, positions: { rows: [] }, history: { rows: [{ filledQuantity: 3 }] },
  });
  render(<OverviewView />);
  expect(await screen.findByText("$123.45")).toBeVisible();
  expect(screen.getByText("Recent orders and fills")).toBeVisible();
  expect(screen.queryByLabelText("Sandbox PIN")).toBeNull();
  expect(tradingRequest).toHaveBeenCalledWith("portfolio", {});
});

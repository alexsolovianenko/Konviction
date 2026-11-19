import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OverviewView } from "./Console";
import { tradingRequest } from "../../browserTrading";

const { feed } = vi.hoisted(() => ({ feed: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: feed }));
vi.mock("../../browserTrading", () => ({ workerTrading: true, PIN_PATTERN: /^\d{4,8}$/, tradingRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("loads exchange fills on a paired device even when the journal is offline and open positions are empty", async () => {
  feed.mockReturnValue({ data: {
    account: { configured: true, usd_available: 10, terms_accepted: true, positions: [], positions_error: null },
    limits: { maxOrderUsd: 25, maxDailyUsd: 50, maxLimitPrice: .95 },
    history_available: false, activity: [], intents: [], orders: [], receipts: [],
  } });
  vi.mocked(tradingRequest).mockResolvedValueOnce({ ok: true, voice_authorized: true }).mockResolvedValueOnce({
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

it("asks for device pairing when the private session expires", async () => {
  feed.mockReturnValue({ isError: true, error: new Error("offline") });
  vi.mocked(tradingRequest).mockResolvedValueOnce({ ok: true, voice_authorized: true })
    .mockResolvedValueOnce({ ok: false, error: "DEVICE_REQUIRED" });
  render(<OverviewView />);
  expect(await screen.findByText("Pair this browser to see order history.")).toBeVisible();
  expect(screen.queryByLabelText("Approval PIN")).toBeNull();
});

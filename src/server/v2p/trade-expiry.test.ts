// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./gemini", async (original) => ({
  ...(await original<typeof import("./gemini")>()),
  getEvent: vi.fn(),
  gPrivate: vi.fn(),
}));
import { getEvent, gPrivate } from "./gemini";
import { executeTrade, prepareTrade } from "./trade-engine";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("prepares a five-minute buy with two minutes remaining, and enforces the one-minute cutoff again before submission", async () => {
  const start = Date.parse("2026-11-19T10:08:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  const ticker = "BTC05M2611191010",
    symbol = "GEMI-" + ticker + "-UP";
  const contract = {
    label: "Up",
    status: "active",
    marketState: "open",
    instrumentSymbol: symbol,
    expiryDate: new Date(start + 120000).toISOString(),
    prices: { buy: { yes: ".20" } },
  };
  vi.mocked(getEvent).mockResolvedValue({
    event: { ticker, title: "Bitcoin Up", contracts: [contract] },
  });
  vi.mocked(gPrivate).mockResolvedValue({
    ok: true,
    status: 200,
    text: "",
    data: { orderId: "12345", filledQuantity: "1", avgExecutionPrice: "0.20" },
  });
  const request = {
    event_ticker: ticker,
    instrument_symbol: symbol,
    side: "buy",
    outcome: "yes",
    quantity: 1,
    max_price: 0.2,
  };
  const save = vi.fn(async (terms) => terms);
  const proposal = await prepareTrade(request, save);
  expect(save).toHaveBeenCalledOnce();
  const hooks = { finish: vi.fn(), log: vi.fn(), saveOrder: vi.fn(), receipt: vi.fn() };
  const intent = { ...proposal, id: "test", code: "test" };
  clock.mockReturnValue(start + 60000);
  expect(await (await executeTrade(intent, "test", hooks)).json()).toMatchObject({
    ok: true,
    outcome_summary: "FILLED",
  });
  expect(gPrivate).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(start + 60001);
  expect(await (await executeTrade(intent, "test", hooks)).json()).toMatchObject({
    ok: false,
    error: "TOO_CLOSE_TO_EXPIRY",
  });
  expect(gPrivate).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(start);
  vi.stubEnv("MIN_MINUTES_TO_EXPIRY", "3");
  expect(await (await prepareTrade(request, save)).json()).toMatchObject({
    error: "TOO_CLOSE_TO_EXPIRY",
  });
  vi.stubEnv("MIN_FIVE_MINUTE_MINUTES_TO_EXPIRY", "1");
  expect(await prepareTrade(request, save)).toMatchObject({ quantity: 1 });
});

it("keeps the five-minute buffer for a longer event", async () => {
  const ticker = "BTC2611191010",
    symbol = "GEMI-" + ticker + "-UP";
  vi.mocked(getEvent).mockResolvedValue({
    event: {
      ticker,
      title: "Bitcoin",
      contracts: [
        {
          instrumentSymbol: symbol,
          status: "active",
          marketState: "open",
          expiryDate: new Date(Date.now() + 120000).toISOString(),
          prices: { buy: { yes: ".20" } },
        },
      ],
    },
  });
  const result = await prepareTrade(
    { event_ticker: ticker, instrument_symbol: symbol, side: "buy", outcome: "yes", quantity: 1 },
    vi.fn(),
  );
  expect(await result.json()).toMatchObject({ error: "TOO_CLOSE_TO_EXPIRY" });
});

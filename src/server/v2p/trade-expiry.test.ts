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

it("prepares a five-minute buy with two minutes remaining, and enforces the ten-second cutoff again before submission", async () => {
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
    data: { orderId: "TEST", filledQuantity: "1", avgExecutionPrice: "0.20" },
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
  clock.mockReturnValue(start + 109999);
  expect(await (await executeTrade(intent, "test", hooks)).json()).toMatchObject({
    ok: true,
    outcome_summary: "FILLED",
  });
  expect(gPrivate).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(start + 110000);
  expect(await (await executeTrade(intent, "test", hooks)).json()).toMatchObject({
    ok: false,
    error: "TOO_CLOSE_TO_EXPIRY",
  });
  expect(gPrivate).toHaveBeenCalledTimes(1);
  expect(await (await prepareTrade(request, save)).json()).toMatchObject({ error: "TOO_CLOSE_TO_EXPIRY" });
  clock.mockReturnValue(start + 120000);
  expect(await (await prepareTrade(request, save)).json()).toMatchObject({ error: "CONTRACT_NOT_OPEN" });
});

it("allows a 97-cent quote or a user-specified 95-cent IOC limit on a longer event with two minutes left", async () => {
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
          prices: { buy: { yes: ".97" } },
        },
      ],
    },
  });
  const request = { event_ticker: ticker, instrument_symbol: symbol, side: "buy", outcome: "yes", quantity: 1 };
  const save = async (terms: Record<string, unknown>) => terms;
  expect(await prepareTrade(request, save)).toMatchObject({limit_price: .97, quote_price: .97});
  expect(await prepareTrade({...request, limit_price: .95}, save)).toMatchObject({limit_price: .95, quote_price: .97});
});

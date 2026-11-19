import { afterEach, expect, it, vi } from "vitest";
import { marketTool } from "./market-tools";
import { klinePoints } from "./settlement-index";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Values Gemini Sandbox returned for BTC05M2611191025 and its index on 2026-11-19.
const START = Date.parse("2026-11-19T10:20:00.000Z");
const EXPIRY = Date.parse("2026-11-19T10:25:00.000Z");
const event = (over: object = {}) => ({
  ticker: "BTC05M2611191025",
  title: "BTC price today at 5:25am EST",
  slug: "btc-price-today-at-525am-est",
  status: "active",
  startTime: "2026-11-19T10:20:00.000Z",
  expiryDate: "2026-11-19T10:25:00.000Z",
  sourceDetails: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
  contracts: [
    {
      instrumentSymbol: "GEMI-BTC05M2611191025-UP",
      strike: { type: "reference", value: "63810.69" },
    },
  ],
  ...over,
});
const klines = [
  [1795083660000, 63834.82, 63834.82, 63794.13, 63814.138166666664, 0],
  [1795083600000, 63812.46, 63852.7, 63810.83, 63836.18666666667, 0],
  [1795083540000, 63817.84, 63817.84, 63804.51, 63810.68633333333, 0],
];
const stub = (eventBody: object, klineResponse: () => Response) => {
  const mock = vi.fn(async (url: URL, _init?: RequestInit) =>
    url.pathname === "/v2/klines" ? klineResponse() : Response.json(eventBody),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
};
const read = async (ticker = "BTC05M2611191025") => {
  const response = await marketTool(
    "get_settlement_index",
    new URLSearchParams({ event_ticker: ticker }),
  );
  return { status: response.status, body: await response.json() };
};

it("plots each index bar at the end of its minute and drops bars outside the window", () => {
  expect(klinePoints(klines, START, EXPIRY)).toEqual([
    { t: START, value: 63810.68633333333 },
    { t: START + 60000, value: 63836.18666666667 },
    { t: START + 120000, value: 63814.138166666664 },
  ]);
  expect(klinePoints(klines, START + 1, EXPIRY)).toHaveLength(2);
  expect(klinePoints([[1795083600000, 1, 1, 1, "x", 0]], START, EXPIRY)).toBeNull();
  expect(klinePoints({ result: "error" }, START, EXPIRY)).toBeNull();
});

it("returns the named index, window, price to beat, deep link and Gemini index history for a live event", async () => {
  vi.spyOn(Date, "now").mockReturnValue(START + 150000);
  const mock = stub(event(), () => Response.json(klines));
  const { body } = await read();
  expect(body).toMatchObject({
    ok: true,
    source: "Gemini Sandbox",
    event_ticker: "BTC05M2611191025",
    status: "active",
    deep_link:
      "https://exchange.sandbox.gemini.com/predictions/BTC05M2611191025/btc-price-today-at-525am-est",
    index: { agency: "lukka", code: "LS-LRRR-XBTUSD", stream: "lukka:LS-LRRR-XBTUSD@indexPrice" },
    starts_at: "2026-11-19T10:20:00.000Z",
    expires_at: "2026-11-19T10:25:00.000Z",
    price_to_beat: 63810.69,
    settlement_value: null,
    history_available: true,
  });
  // The first point is the index at the window start: the value Gemini published as the price to beat.
  expect(body.history[0]).toEqual({ t: START, value: 63810.68633333333 });
  expect(body.history).toHaveLength(3);
  const kline = mock.mock.calls.map(([url]) => url).find((url) => url.pathname === "/v2/klines")!;
  expect(Object.fromEntries(kline.searchParams)).toEqual({
    agency: "lukka",
    index: "LS-LRRR-XBTUSD",
    interval: "1m",
    startTime: String(START - 60000),
    endTime: String(START + 150000),
  });
  for (const [url, init] of mock.mock.calls) {
    expect(url.origin).toBe("https://api.sandbox.gemini.com");
    expect(init).toMatchObject({ method: "GET", headers: { Accept: "application/json" } });
  }
});

it("reports the settlement of an expired event and never requests history past its expiry", async () => {
  vi.spyOn(Date, "now").mockReturnValue(EXPIRY + 600000);
  const mock = stub(event({ status: "settled", settlement: { value: "63786.04116666667" } }), () =>
    Response.json(klines),
  );
  const { body } = await read();
  expect(body).toMatchObject({
    status: "settled",
    settlement_value: 63786.04116666667,
    price_to_beat: 63810.69,
  });
  expect(
    mock.mock.calls
      .map(([url]) => url)
      .find((url) => url.pathname === "/v2/klines")!
      .searchParams.get("endTime"),
  ).toBe(String(EXPIRY));
});

it("returns no history, rather than a substitute, when Gemini has no index klines", async () => {
  vi.spyOn(Date, "now").mockReturnValue(START + 150000);
  stub(event(), () => new Response("", { status: 400 }));
  expect((await read()).body).toMatchObject({
    ok: true,
    history: [],
    history_available: false,
    index: { code: "LS-LRRR-XBTUSD" },
  });
});

it("names no index and requests no history for an event without a published source index", async () => {
  vi.spyOn(Date, "now").mockReturnValue(START + 150000);
  const mock = stub(event({ sourceDetails: undefined }), () => Response.json(klines));
  const { body } = await read();
  expect(body).toMatchObject({ ok: true, index: null, history: [], history_available: false });
  expect(body.deep_link).toBe(
    "https://exchange.sandbox.gemini.com/predictions/BTC05M2611191025/btc-price-today-at-525am-est",
  );
  expect(mock).toHaveBeenCalledTimes(1);
});

it("omits a price to beat for strike ladders and rejects bad identifiers and unknown events", async () => {
  vi.spyOn(Date, "now").mockReturnValue(START + 150000);
  const mock = stub(
    event({ contracts: [{ strike: { value: "1" } }, { strike: { value: "2" } }] }),
    () => Response.json([]),
  );
  expect((await read()).body.price_to_beat).toBeNull();
  expect((await read("OTHER")).status).toBe(404);
  mock.mockClear();
  expect((await read("../x")).status).toBe(400);
  expect(
    (
      await marketTool(
        "get_settlement_index",
        new URLSearchParams({ event_ticker: "E", contract_symbol: "C" }),
      )
    ).status,
  ).toBe(400);
  expect(mock).not.toHaveBeenCalled();
});

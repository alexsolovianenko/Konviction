import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Proposal } from "../../browserTrading";
import type { Lookup, MarketResult } from "../../pages/useMarketTools";
import { PredictionPanel, selectTarget } from "./PredictionPanel";
import { QuoteChart } from "./QuoteChart";
import { useContractQuotes } from "./useContractQuotes";

const { voiceState } = vi.hoisted(() => ({ voiceState: vi.fn() }));
vi.mock("../voice/VoiceProvider", () => ({ useVoice: voiceState }));
vi.mock("../../browserTrading", () => ({
  PIN_PATTERN: /^\d{4,8}$/,
  tradingRequest: vi.fn(async () => ({
    ok: true,
    execution_enabled: true,
    message: "Sandbox approval ready.",
  })),
}));

const START = Date.parse("2026-11-19T09:40:00.000Z");
const contract = (over: object = {}) => ({
  symbol: "GEMI-BTC05M-UP",
  label: "Up",
  status: "active",
  market_state: "open",
  expiry: "2026-11-19T09:45:00.000Z",
  buy: { yes: 0.06, no: 0.97 },
  sell: { yes: 0.03, no: 0.94 },
  ...over,
});
const quote = (over: object = {}, c: object = {}) =>
  Response.json({
    ok: true,
    as_of: new Date().toISOString(),
    event_ticker: "BTC05M",
    title: "BTC price today",
    contract: contract(c),
    ...over,
  });
const fetchMock = vi.fn();
const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const target = { eventTicker: "BTC05M", symbol: "GEMI-BTC05M-UP" };

it("samples only the selected contract from the read-only quote route with route timestamps", async () => {
  fetchMock.mockImplementation(async () => quote());
  const { result } = renderHook(() => useContractQuotes(target));
  await flush();
  await flush(5000);
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(
    Array(2).fill(
      "/api/public/market-tools/get_orderbook?event_ticker=BTC05M&contract_symbol=GEMI-BTC05M-UP",
    ),
  );
  expect(fetchMock.mock.calls.every((call) => call[1].method === undefined)).toBe(true);
  expect(result.current.status).toBe("live");
  expect(result.current.samples).toEqual([
    { t: START, yes: 0.06, no: 0.97, gap: false },
    { t: START + 5000, yes: 0.06, no: 0.97, gap: false },
  ]);
});

it("never plots a mismatched contract, a bad timestamp or a repeated timestamp", async () => {
  fetchMock
    .mockImplementationOnce(async () => quote({}, { symbol: "GEMI-OTHER" }))
    .mockImplementationOnce(async () => quote({ event_ticker: "OTHER" }))
    .mockImplementationOnce(async () => quote({ as_of: "not a time" }))
    .mockImplementationOnce(async () => quote({ as_of: new Date(START + 15000).toISOString() }))
    .mockImplementationOnce(async () =>
      quote({ as_of: new Date(START + 15000).toISOString() }, { buy: { yes: 0.5, no: 0.5 } }),
    );
  const { result } = renderHook(() => useContractQuotes(target));
  await flush();
  await flush(5000);
  await flush(5000);
  expect(result.current.samples).toEqual([]);
  expect(result.current.status).toBe("stale");
  await flush(5000);
  expect(result.current.samples).toHaveLength(1);
  await flush(5000);
  expect(result.current.samples).toEqual([{ t: START + 15000, yes: 0.06, no: 0.97, gap: false }]);
  expect(result.current.status).toBe("stale");
});

it("keeps the last sample when a poll fails and marks the gap instead of bridging it", async () => {
  fetchMock
    .mockImplementationOnce(async () => quote())
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(async () => new Response("", { status: 502 }))
    .mockImplementationOnce(async () => new Response("", { status: 502 }))
    .mockImplementation(async () => quote({}, { buy: { yes: null, no: 2 } }));
  const { result } = renderHook(() => useContractQuotes(target));
  await flush();
  await flush(5000);
  expect(result.current).toMatchObject({
    status: "stale",
    message: "Gemini Sandbox quote unavailable. Retrying.",
  });
  expect(result.current.samples).toHaveLength(1);
  await flush(15000);
  expect(result.current.status).toBe("live");
  // Out-of-range and missing prices become "unavailable", never a made-up number.
  expect(result.current.samples[1]).toEqual({ t: START + 20000, yes: null, no: null, gap: true });
});

it("stops sampling once Gemini reports the contract closed, expired or gone", async () => {
  for (const response of [
    () => quote({}, { market_state: "closed" }),
    () => quote({}, { expiry: new Date(START).toISOString() }),
    () =>
      Response.json(
        { ok: false, error: "Prediction contract unavailable for this event." },
        { status: 404 },
      ),
  ]) {
    fetchMock.mockReset().mockImplementation(async () => response());
    const { result, unmount } = renderHook(() => useContractQuotes(target));
    await flush();
    await flush(30000);
    expect(result.current.status).toBe("closed");
    expect(result.current.samples).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  }
});

it("drops a late response for the previous contract and stops polling on unmount", async () => {
  let release: (response: Response) => void = () => {};
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async () =>
      quote({ event_ticker: "NEXT" }, { symbol: "GEMI-NEXT", buy: { yes: 0.4, no: 0.61 } }),
    );
  const { result, rerender, unmount } = renderHook(({ t }) => useContractQuotes(t), {
    initialProps: { t: target },
  });
  await flush();
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(false);
  rerender({ t: { eventTicker: "NEXT", symbol: "GEMI-NEXT" } });
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
  release(quote());
  await flush();
  expect(result.current.samples).toEqual([{ t: START, yes: 0.4, no: 0.61, gap: false }]);
  expect(result.current.contract?.symbol).toBe("GEMI-NEXT");
  const calls = fetchMock.mock.calls.length;
  unmount();
  await flush(60000);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it("selects the proposal contract first, then a quoted contract, then a five-minute search match", () => {
  const event = {
    ticker: "BTC05M",
    title: "BTC",
    category: null,
    status: "active",
    contracts: [contract()],
  };
  const search: MarketResult = { ok: true, events: [event, { ...event, ticker: "LATER" }] };
  const lookup = (query: string): Lookup[] => [
    { id: 1, name: "search_markets", params: { query }, result: search, received: "" },
  ];
  expect(selectTarget(null, search, lookup("BTC five minutes"))).toEqual(target);
  expect(selectTarget(null, search, lookup("bitcoin 5 min"))).toEqual(target);
  expect(selectTarget(null, search, lookup("bitcoin"))).toBeNull();
  expect(
    selectTarget(
      null,
      { ok: true, events: [{ ...event, contracts: [contract(), contract()] }] },
      [],
    ),
  ).toBeNull();
  expect(selectTarget(null, { ok: false, error: "down" }, [])).toBeNull();
  const quoted = {
    ok: true,
    event_ticker: "EV",
    contract: contract({ symbol: "GEMI-EV-A" }),
  } as MarketResult;
  expect(selectTarget(null, quoted, [])).toEqual({ eventTicker: "EV", symbol: "GEMI-EV-A" });
  const proposal = { instrument_symbol: "GEMI-P", event_ticker: "P" } as unknown as Proposal;
  expect(selectTarget(proposal, quoted, [])).toEqual({ eventTicker: "P", symbol: "GEMI-P" });
  expect(selectTarget({ instrument_symbol: "GEMI-P" } as Proposal, quoted, [])).toBeNull();
});

it("draws nothing without samples and breaks the line at gaps and unavailable prices", () => {
  const { container, rerender } = render(<QuoteChart samples={[]} />);
  expect(container).toBeEmptyDOMElement();
  rerender(
    <QuoteChart
      samples={[
        { t: START, yes: 0.1, no: 0.9, gap: false },
        { t: START + 5000, yes: 0.2, no: null, gap: false },
        { t: START + 30000, yes: 0.3, no: 0.7, gap: true },
      ]}
    />,
  );
  const [yes, no] = Array.from(container.querySelectorAll("path")).map((path) =>
    path.getAttribute("d")!,
  );
  expect(yes!.match(/[ML]/g)).toEqual(["M", "L", "M"]);
  expect(no!.match(/[ML]/g)).toEqual(["M", "M"]);
  const chart = screen.getByRole("img");
  expect(chart).toHaveAccessibleName(/3 samples\. Latest YES 30¢, NO 70¢/);
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
  expect(screen.getByRole("status")).toHaveTextContent("YES 20¢");
  expect(screen.getByRole("status")).toHaveTextContent("NO unavailable");
});

it("shows the labelled chart and the full PIN approval for the same contract", async () => {
  fetchMock.mockImplementation(async () => quote());
  const approve = vi.fn(async () => {});
  const proposal = {
    proposal_id: "p1",
    title: "BTC price today",
    contract_label: "Up",
    instrument_symbol: "GEMI-BTC05M-UP",
    event_ticker: "BTC05M",
    outcome: "yes",
    quantity: 2,
    limit_price: 0.07,
    quote_price: 0.06,
    est_fee_usd: 0.01,
    notional_usd: 0.14,
    expires_at: new Date(START + 60000).toISOString(),
    readback: "Buy 2 YES",
  };
  const state = (over: object) => ({
    voice: { approve },
    market: { result: undefined, history: [] },
    view: { proposal: null, availability: null, tradeMessage: "" },
    ...over,
  });
  voiceState.mockReturnValue(state({}));
  const { container, rerender } = render(<PredictionPanel />);
  expect(container).toBeEmptyDOMElement();
  expect(fetchMock).not.toHaveBeenCalled();

  voiceState.mockReturnValue(
    state({
      view: {
        proposal,
        availability: { execution_enabled: true, message: "ready" },
        tradeMessage: "",
      },
    }),
  );
  rerender(<PredictionPanel />);
  await flush();
  // The chart card and the approval card name the same event and contract.
  expect(screen.getAllByRole("heading", { name: "BTC price today · Up" })).toHaveLength(2);
  expect(screen.getByText(/Session-observed Gemini Sandbox YES\/NO buy prices/)).toHaveTextContent(
    "This is not the BTC price",
  );
  expect(screen.getByText("Max. cost incl. est. fee").nextSibling).toHaveTextContent("$0.15");
  fireEvent.change(screen.getByLabelText("Private approval PIN"), { target: { value: "7314" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve sandbox buy" }));
  });
  expect(approve).toHaveBeenCalledWith("p1", "7314");
  // Polling for the chart never touches a trading route.
  expect(
    fetchMock.mock.calls.every((call) =>
      String(call[0]).startsWith("/api/public/market-tools/get_orderbook?"),
    ),
  ).toBe(true);
});

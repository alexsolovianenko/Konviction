import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettlementIndexPanel } from "./SettlementIndexPanel";

// Values Gemini Sandbox returned for BTC05M2611191025 and its index stream on 2026-11-19.
const START = Date.parse("2026-11-19T10:20:00.000Z");
const EXPIRY = Date.parse("2026-11-19T10:25:00.000Z");
const LINK =
  "https://exchange.sandbox.gemini.com/predictions/BTC05M2611191025/btc-price-today-at-525am-est";
const info = (over: object = {}) =>
  Response.json({
    ok: true,
    event_ticker: "BTC05M2611191025",
    deep_link: LINK,
    index: { agency: "lukka", code: "LS-LRRR-XBTUSD", stream: "lukka:LS-LRRR-XBTUSD@indexPrice" },
    starts_at: "2026-11-19T10:20:00.000Z",
    expires_at: "2026-11-19T10:25:00.000Z",
    price_to_beat: 63810.69,
    settlement_value: null,
    history: [{ t: START, value: 63810.68633333333 }],
    history_available: true,
    ...over,
  });

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  tick(seconds: number, p: string) {
    act(() =>
      this.onmessage?.({
        data: JSON.stringify({ e: "thirdPartyPrice", E: seconds, s: "btcusd", p }),
      }),
    );
  }
}

const fetchMock = vi.fn();
const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const show = async () => {
  render(<SettlementIndexPanel eventTicker="BTC05M2611191025" />);
  await flush();
};

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.setSystemTime(START + 150000);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("subscribes to the event's own index stream and plots only in-window Gemini ticks", async () => {
  fetchMock.mockImplementation(async () => info());
  await show();
  expect(String(fetchMock.mock.calls[0]![0])).toBe(
    "/api/public/market-tools/get_settlement_index?event_ticker=BTC05M2611191025",
  );
  const socket = FakeSocket.all[0]!;
  expect(socket.url).toBe("wss://ws.sandbox.gemini.com");
  act(() => socket.onopen?.());
  expect(JSON.parse(socket.sent[0]!)).toMatchObject({
    method: "SUBSCRIBE",
    params: ["lukka:LS-LRRR-XBTUSD@indexPrice"],
  });

  expect(
    screen.getByRole("heading", {
      name: /LS-LRRR-XBTUSD.*Lukka one-minute settlement index · USD/,
    }),
  ).toBeVisible();
  expect(screen.getByText("Price to beat").nextSibling).toHaveTextContent("$63,810.69");
  expect(screen.getByText("Current index").nextSibling).toHaveTextContent("$63,810.69");

  act(() => socket.onmessage?.({ data: JSON.stringify({ id: "sub-1", status: 200 }) }));
  socket.tick((START - 1000) / 1000, "1.00"); // before the window
  socket.tick((START + 151000) / 1000, "63778.25666666667");
  socket.tick((EXPIRY + 1000) / 1000, "2.00"); // after expiry
  act(() => socket.onmessage?.({ data: "not json" }));
  act(() => socket.onmessage?.({ data: JSON.stringify({ E: (START + 152000) / 1000, p: "NaN" }) }));

  expect(screen.getByText("Current index").nextSibling).toHaveTextContent("$63,778.26");
  expect(screen.getByText("Live · Gemini Sandbox")).toBeVisible();
  expect(screen.getByRole("img")).toHaveAccessibleName(
    /2 points\. Latest \$63,778\.26 .* Price to beat \$63,810\.69\./,
  );
  expect(screen.getByText(/not the contract's YES\/NO price or a spot market price/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Open the original chart on Gemini" })).toHaveAttribute(
    "href",
    LINK,
  );
});

it("stops the stream at expiry and then shows the settlement value Gemini publishes", async () => {
  fetchMock.mockImplementation(async () => info());
  await show();
  const socket = FakeSocket.all[0]!;
  fetchMock.mockImplementation(async () =>
    info({
      settlement_value: 63786.04116666667,
      history: [{ t: EXPIRY, value: 63786.04116666667 }],
    }),
  );
  await flush(150000 + 8000);
  expect(socket.closed).toBe(true);
  expect(screen.getByText("Event closed")).toBeVisible();
  expect(screen.getByText("Settlement value").nextSibling).toHaveTextContent("$63,786.04");
  const calls = fetchMock.mock.calls.length;
  await flush(60000);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  expect(FakeSocket.all).toHaveLength(1);
});

it("opens no stream for an event that has already expired", async () => {
  vi.setSystemTime(EXPIRY + 600000);
  fetchMock.mockImplementation(async () => info({ settlement_value: 63786.04116666667 }));
  await show();
  expect(FakeSocket.all).toHaveLength(0);
  expect(screen.getByText("Event closed")).toBeVisible();
  expect(screen.getByText("Settlement value").nextSibling).toHaveTextContent("$63,786.04");
  // The window-start value from history plus the settlement at expiry.
  expect(screen.getByRole("img")).toHaveAccessibleName(/2 points\. Latest \$63,786\.04/);
});

it("plots only the published settlement, and links the original chart, when the expired window has no Gemini history", async () => {
  vi.setSystemTime(EXPIRY + 600000);
  fetchMock.mockImplementation(async () =>
    info({ settlement_value: 63786.04116666667, history: [], history_available: false }),
  );
  await show();
  expect(screen.getByRole("img")).toHaveAccessibleName(/1 points\. Latest \$63,786\.04/);
  expect(screen.getByRole("link", { name: "Open the original chart on Gemini" })).toHaveAttribute(
    "href",
    LINK,
  );
});

it("shows an unavailable state with the deep link when Gemini names no index or rejects the stream", async () => {
  fetchMock.mockImplementation(async () => info({ index: null, history: [], price_to_beat: null }));
  await show();
  expect(FakeSocket.all).toHaveLength(0);
  expect(
    screen.getAllByText("Gemini does not publish a settlement index for this event.").length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("link", { name: "Open the original chart on Gemini" })).toHaveAttribute(
    "href",
    LINK,
  );
  cleanup();

  fetchMock.mockImplementation(async () => info({ history: [] }));
  await show();
  const socket = FakeSocket.all[0]!;
  act(() => socket.onmessage?.({ data: JSON.stringify({ id: "sub-1", status: 400 }) }));
  expect(socket.closed).toBe(true);
  expect(screen.getAllByText("Gemini Sandbox does not stream this index.").length).toBeGreaterThan(
    0,
  );
  await flush(20000);
  expect(FakeSocket.all).toHaveLength(1);
});

it("reconnects after a dropped stream and ignores a response for another event", async () => {
  fetchMock.mockImplementation(async () => info());
  await show();
  act(() => FakeSocket.all[0]!.onclose?.());
  expect(screen.getByText("Gemini index stream interrupted. Reconnecting.")).toBeVisible();
  await flush(5000);
  expect(FakeSocket.all).toHaveLength(2);
  cleanup();

  FakeSocket.all = [];
  fetchMock.mockImplementation(async () => info({ event_ticker: "OTHER" }));
  await show();
  expect(FakeSocket.all).toHaveLength(0);
  expect(screen.getAllByText("Gemini Sandbox event details unavailable.").length).toBeGreaterThan(
    0,
  );
});

it("counts down to the event's expiry each second", async () => {
  fetchMock.mockImplementation(async () => info());
  await show();
  expect(screen.getByText("Expires in").nextElementSibling?.textContent).toBe("2:30");
  await flush(1000);
  expect(screen.getByText("Expires in").nextElementSibling?.textContent).toBe("2:29");
});

it("reads the price to beat once an upcoming window opens", async () => {
  vi.setSystemTime(START - 60000);
  fetchMock
    .mockImplementationOnce(async () => info({ price_to_beat: null, history: [] }))
    .mockImplementation(async () => info());
  await show();
  expect(screen.getByRole("status").textContent).toMatch(/^Window opens at /);
  expect(screen.getByText("Price to beat").nextElementSibling?.textContent).toBe("—");
  await flush(63000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Price to beat").nextElementSibling?.textContent).toBe("$63,810.69");
});

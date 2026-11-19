import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMarketTools } from "../../pages/useMarketTools";
import { MarketDiscoveryPanel } from "./MarketDiscoveryPanel";
const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../voice/VoiceProvider", () => ({ useVoice: context }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps independently tracked outcomes until the user removes them or resets the session", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          track_group: true,
          events: [
            { ticker: "BTC", title: "Bitcoin", contracts: [{ symbol: "C1", label: "Up" }] },
            { ticker: "ETH", title: "Ethereum", contracts: [{ symbol: "C2", label: "Up" }] },
          ],
          timing: [
            { selected_event_ticker: "BTC", tracked_outcome: "yes" },
            { selected_event_ticker: "ETH", tracked_outcome: "no" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, events: [] })),
  );
  const { result } = renderHook(useMarketTools);
  await act(async () => {
    await result.current.run("search_markets", { query: "track BTC up ETH down 5 minute" });
  });
  expect(result.current.tracked.map((t) => [t.symbol, t.outcome])).toEqual([
    ["C1", "yes"],
    ["C2", "no"],
  ]);
  await act(async () => {
    await result.current.run("search_markets", { query: "gold" });
  });
  expect(result.current.tracked).toHaveLength(2);
  act(() => result.current.untrack("C2"));
  expect(result.current.tracked).toHaveLength(1);
  act(() => result.current.reset());
  expect(result.current.tracked).toHaveLength(0);
});

it("opens the native combo's own quote with the exact pair returned by Gemini", () => {
  const run = vi.fn();
  const combo = {
    title: "Bitcoin and Ethereum",
    event_ticker: "COMBO-EVENT",
    symbol: "NATIVE-SYMBOL",
    legs: [
      { title: "Bitcoin", label: "Up", outcome: "Yes" },
      { title: "Ethereum", label: "Up", outcome: "No" },
    ],
  };
  context.mockReturnValue({
    market: {
      run,
      tracked: [],
      result: {
        combos: [
          { ...combo, can_request_quote: true },
          { ...combo, title: "Expired combo", symbol: "OLD", can_request_quote: false },
        ],
      },
    },
  });
  render(<MarketDiscoveryPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Quote combo", hidden: true }));
  expect(run).toHaveBeenCalledWith("get_orderbook", {
    event_ticker: "COMBO-EVENT",
    contract_symbol: "NATIVE-SYMBOL",
  });
  expect(screen.getByText("Unavailable for trading")).toBeTruthy();
});

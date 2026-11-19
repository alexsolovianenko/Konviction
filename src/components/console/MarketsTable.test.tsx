import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketsTable } from "./Console";
import type { MarketEvent } from "./types";
import { browseQuery, marketSortLabels, type MarketSort } from "../../lib/market-sort";
import { useMarketTools } from "../../pages/useMarketTools";

const { feed } = vi.hoisted(() => ({ feed: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: feed }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("ranks the full listing from the menu and keeps the same topic when voice changes the sort", async () => {
  const sorts = Object.keys(marketSortLabels) as MarketSort[];
  const events: MarketEvent[] = sorts.map((key, i) => ({
    ticker: key, title: "Gold " + key, category: "Gold", status: "active",
    featured_rank: key === "featured" ? 0 : 10, volume_usd: key === "volume" ? 90 : 2,
    volume_24h_usd: key === "volume_24h" ? 50 : null,
    created_at: key === "newest" ? "2026-01-01" : "2024-01-01",
    contracts: [{
      symbol: "C" + i, label: "Yes", status: "active", market_state: "open",
      expiry: key === "expiry" ? "2098-01-01" : "2099-01-01",
      buy: { yes: .6, no: .5 }, sell: { yes: .5, no: .4 },
    }],
  }));
  feed.mockReturnValue({ data: { markets: { events, error: null } } });
  const fetchMock = vi.fn(async (path: string) => {
    const params = new URL(path, "https://app.test").searchParams;
    const parsed = browseQuery(params.get("query")!, params.get("sort") as MarketSort);
    return Response.json({ ok: true, query: parsed.query, topic: parsed.topic, sort: parsed.sort,
      min_volume: parsed.minVolume, ending_minutes: parsed.endingMinutes, events: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  function Harness() {
    const market = useMarketTools();
    return <>
      <MarketsTable market={market} />
      <button onClick={() => void market.run("search_markets", { query: "sort these by 24h volume" })}>Voice sort</button>
    </>;
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Filter listed contracts"), { target: { value: "gold" } });
  const menu = screen.getByRole("combobox", { name: "Sort by" });
  const firstTitle = () => within(screen.getByRole("table")).getAllByRole("row")[1]?.querySelector("td div")?.textContent;
  for (const key of sorts) {
    fireEvent.change(menu, { target: { value: key } });
    await waitFor(() => {
      expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("query=gold&sort=" + key);
      expect(firstTitle()).toBe("Gold " + key);
    });
  }
  fireEvent.click(screen.getByText("Voice sort"));
  await waitFor(() => {
    expect(menu).toHaveValue("volume_24h");
    expect(firstTitle()).toBe("Gold volume_24h");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("query=gold&sort=volume_24h");
  });
  fireEvent.change(screen.getByLabelText("Minimum event volume in USD"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("Time to expiry"), { target: { value: "60" } });
  fireEvent.click(screen.getByText("Voice sort"));
  await waitFor(() => {
    const url = new URL(fetchMock.mock.calls.at(-1)![0], "https://app.test");
    expect(url.searchParams.get("query")).toBe("gold minimum volume 5 ending within 60 minutes");
    expect(url.searchParams.get("sort")).toBe("volume_24h");
    expect(screen.getByLabelText("Filter listed contracts")).toHaveValue("gold");
    expect(screen.getByLabelText("Time to expiry")).toHaveValue("60");
  });
});

import { dashboardMarkets, dashboardMarketsFrom } from "./dashboard-markets";
import { gPublic, geminiReadError } from "./gemini";

export async function marketTool(name: string, params: URLSearchParams) {
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  const fields = name === "search_markets" ? ["query"] : ["event_ticker", "contract_symbol"];
  if (!["search_markets", "get_orderbook"].includes(name)) return fail("Unknown market tool.", 404);
  if (Array.from(params.keys()).length !== fields.length || fields.some(k => !params.has(k) || params.get(k)!.length > 200))
    return fail("Invalid market tool parameters.", 400);
  if (name === "search_markets") {
    const { events, error } = await dashboardMarkets(true);
    if (error) return fail(error, 502);
    const query = params.get("query")!.toLowerCase().replace(/\bbitcoin\b/g, "btc")
      .replace(/\b(?:five|5)[ -]?(?:minutes?|mins?|m)\b/g, "05m").trim();
    const words = query.split(/\s+/);
    const fiveMinute = words.includes("05m");
    const now = Date.now();
    const matches = events.flatMap(event => {
      const title = [event.title, event.category, event.ticker].join(" ").toLowerCase();
      const contracts = event.contracts.filter(c => (!fiveMinute || (c.status === "active" && c.market_state === "open" && Date.parse(c.expiry ?? "") > now)) && words.every(w => (title + " " + c.symbol + " " + c.label).toLowerCase().includes(w)));
      return contracts.length ? [{ ...event, contracts: contracts.slice(0, 8) }] : [];
    });
    if (fiveMinute) {
      const expiry = (e: typeof matches[number]) => Math.min(...e.contracts.map(c => Date.parse(c.expiry!)));
      matches.sort((a, b) => expiry(a) - expiry(b));
    }
    return Response.json({ ok: true, as_of: new Date().toISOString(), source: "Gemini Sandbox", events: matches.slice(0, 8), matched_events: matches.length });
  }
  const ticker = params.get("event_ticker")!;
  const symbol = params.get("contract_symbol")!;
  if (![ticker, symbol].every(v => /^[a-z0-9_.-]+$/i.test(v) && !/^\.+$/.test(v))) return fail("Invalid prediction contract identifier.", 400);
  const result = await gPublic("/v1/prediction-markets/events/" + encodeURIComponent(ticker));
  if (!result.ok) return fail("Gemini Sandbox event unavailable: " + geminiReadError(result), 502);
  const row = result.data?.data ?? result.data;
  const event = dashboardMarketsFrom({ data: Array.isArray(row) ? row : [row] })?.find(e => e.ticker === ticker);
  const contract = event?.contracts.find(c => c.symbol === symbol);
  if (!event || !contract) return fail("Prediction contract unavailable for this event.", 404);
  return Response.json({ ok: true, source: "Gemini Sandbox", as_of: new Date().toISOString(), event_ticker: ticker, title: event.title, contract });
}

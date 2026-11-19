import { dashboardMarkets, dashboardMarketsFrom } from "./dashboard-markets";
import { comboEligibility } from "./native-combo";
import { gPublic, geminiReadError, findContract, type GEvent } from "./gemini";
import { settlementIndex } from "./settlement-index";

import { normalizeMarketQuery, discoverCombos, fiveMinuteDiscovery, secondsUntil, payoutAtAsk } from "./prediction-discovery";

export async function marketTool(name: string, params: URLSearchParams) {
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  const fields = name === "search_markets" ? ["query"] : name === "get_settlement_index" ? ["event_ticker"] : ["event_ticker", "contract_symbol"];
  if (!["search_markets", "get_orderbook", "get_settlement_index"].includes(name)) return fail("Unknown market tool.", 404);
  if (Array.from(params.keys()).length !== fields.length || fields.some(k => !params.has(k) || params.get(k)!.length > 200))
    return fail("Invalid market tool parameters.", 400);
  if (name === "get_settlement_index") return settlementIndex(params.get("event_ticker")!);
  if (name === "search_markets") {
    const query = normalizeMarketQuery(params.get("query")!);
    const assets = [...new Set(query.match(/\b(?:btc|eth|sol|xrp)\b/g) ?? [])];
    try {
      if (/\b(?:combos?|parlays?)\b/.test(query)) return Response.json(await discoverCombos(query));
      if (/\b05m\b/.test(query) && assets.length && query.split(/[\s,&+/]+/).every(
        word => ["btc","eth","sol","xrp","05m","and","track","nearest","current","up","down","yes","no",""].includes(word)
      )) return Response.json(await fiveMinuteDiscovery(assets, query));
    } catch {
      return fail("Gemini Sandbox listing unavailable.", 502);
    }
    const { events, error } = await dashboardMarkets(true);
    if (error) return fail(error, 502);
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
  const rawEvent = (Array.isArray(row) ? row : [row]).find((e: GEvent) => e?.ticker === ticker);
  const rawContract = findContract(rawEvent, symbol);
  if (!rawContract) return fail("Prediction contract unavailable for this event.", 404);
  const comboError = await comboEligibility(rawEvent, rawContract);
  if (comboError) return fail(comboError, 409);
  const now = Date.now();
  return Response.json({ ok: true, source: "Gemini Sandbox", as_of: new Date(now).toISOString(),
    event_ticker: ticker, title: event.title, contract, seconds_to_expiry: secondsUntil(contract.expiry, now),
    payout_per_contract: { yes: payoutAtAsk(contract.buy.yes), no: payoutAtAsk(contract.buy.no) } });
}

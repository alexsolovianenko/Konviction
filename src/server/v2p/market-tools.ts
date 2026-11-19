import { browseQuery, isMarketSort } from "../../lib/market-sort";
import { compareMarketRanks, marketRank } from "../../lib/market-rank";
import { liquiditySnapshot, type LiquidityQuery } from "./book-liquidity";
import { dashboardMarkets, dashboardMarketsFrom } from "./dashboard-markets";
import { comboEligibility } from "./native-combo";
import { gPublic, geminiReadError, findContract, type GEvent } from "./gemini";
import { settlementIndex } from "./settlement-index";

import { discoverCombos, fiveMinuteDiscovery, secondsUntil, payoutAtAsk } from "./prediction-discovery";

// Gemini quotes its binary book on the YES side. A resting YES bid at p
// supplies a NO buy at 1 - p. Only attach size if both snapshots agree.
function displayedBuySize(level: { price?: unknown; amount?: unknown } | undefined, quote: number | null, complement: boolean) {
  if (quote == null || !level) return null;
  const price = Number(level.price);
  const amount = Number(level.amount);
  if (!(price > 0 && price < 1 && Number.isFinite(amount) && amount > 0)) return null;
  return Math.abs((complement ? 1 - price : price) - quote) < 1e-9 ? amount : null;
}

export async function marketTool(name: string, params: URLSearchParams) {
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  const fields = name === "search_markets" ? ["query"] : name === "get_settlement_index" ? ["event_ticker"] : ["event_ticker", "contract_symbol"];
  if (!["search_markets", "get_orderbook", "get_settlement_index"].includes(name)) return fail("Unknown market tool.", 404);
  const optional = name === "get_orderbook" ? ["outcome", "side", "quantity", "limit_price"] : name === "search_markets" ? ["sort"] : [];
  if (fields.some(k => !params.has(k)) || Array.from(params).some(([key, value]) =>
    ![...fields, ...optional].includes(key) || params.getAll(key).length !== 1 || value.length > 200))
    return fail("Invalid market tool parameters.", 400);
  if (name === "get_settlement_index") return settlementIndex(params.get("event_ticker")!);
  if (name === "search_markets") {
    const requestedSort = params.get("sort");
    if (requestedSort !== null && !isMarketSort(requestedSort)) return fail("Unknown market sort.", 400);
    const { topic: query, query: filterQuery, minVolume, endingMinutes, sort, browsing } = browseQuery(params.get("query")!, requestedSort);
    const rankByExpiry = sort === "expiry" || endingMinutes !== null;
    const assets = [...new Set(query.match(/\b(?:btc|eth|sol|xrp)\b/g) ?? [])];
    try {
      if (/\b(?:combos?|parlays?)\b/.test(query)) {
        if (browsing) return fail("Market rankings apply to events. Browse native combos without ranking filters.", 422);
        return Response.json(await discoverCombos(query));
      }
      if (!browsing && /\b05m\b/.test(query) && assets.length && query.split(/[\s,&+/]+/).every(
        word => ["btc","eth","sol","xrp","05m","and","track","nearest","current","up","down","yes","no",""].includes(word)
      )) return Response.json(await fiveMinuteDiscovery(assets, query));
    } catch {
      return fail("Gemini Sandbox listing unavailable.", 502);
    }
    const { events, error, as_of } = await dashboardMarkets({ fresh: !browsing, requireFeatured: sort === "featured" });
    if (error) return fail(error, 502);
    const words = query.split(/\s+/);
    const fiveMinute = words.includes("05m");
    const now = Date.now();
    const matches = events.flatMap(event => {
      if (minVolume !== null && (event.volume_usd == null || event.volume_usd < minVolume)) return [];
      const title = [event.title, event.category, event.ticker].join(" ").toLowerCase();
      const contracts = event.contracts.filter(c => {
        const expiry = Date.parse(c.expiry ?? "");
        if (fiveMinute && !(c.status === "active" && c.market_state === "open" && expiry > now)) return false;
        if ((endingMinutes !== null || (rankByExpiry && Number.isFinite(expiry))) && !(expiry > now)) return false;
        if (endingMinutes !== null && expiry > now + endingMinutes * 60_000) return false;
        return words.every(w => (title + " " + c.symbol + " " + c.label).toLowerCase().includes(w));
      });
      if (rankByExpiry || fiveMinute) contracts.sort((a, b) => compareMarketRanks(
        marketRank("expiry", event, a.expiry), marketRank("expiry", event, b.expiry), false));
      return contracts.length ? [{ ...event, contracts: contracts.slice(0, 8) }] : [];
    });
    const order = sort ?? (fiveMinute ? "expiry" : null);
    if (order) {
      const descending = order === "volume" || order === "volume_24h" || order === "newest";
      matches.sort((a, b) => compareMarketRanks(marketRank(order, a, a.contracts[0]!.expiry), marketRank(order, b, b.contracts[0]!.expiry), descending));
    }
    return Response.json({ ok: true, as_of, source: "Gemini Sandbox", query: filterQuery, topic: query,
      ...(sort && { sort, say: matches.length ? "Sorted." : "No matching markets." }), ...(minVolume !== null && { min_volume: minVolume }), ...(endingMinutes !== null && { ending_minutes: endingMinutes }),
      events: matches.slice(0, 8), matched_events: matches.length });
  }
  const ticker = params.get("event_ticker")!;
  const symbol = params.get("contract_symbol")!;
  if (![ticker, symbol].every(v => /^[a-z0-9_.-]+$/i.test(v) && !/^\.+$/.test(v))) return fail("Invalid prediction contract identifier.", 400);
  let liquidityQuery: LiquidityQuery | null = null;
  if (optional.some(key => params.has(key))) {
    const outcome = params.get("outcome");
    const side = params.get("side") ?? "buy";
    const quantity = params.has("quantity") ? Number(params.get("quantity")) : null;
    const limit = params.has("limit_price") ? Number(params.get("limit_price")) : null;
    if ((outcome !== "yes" && outcome !== "no") || (side !== "buy" && side !== "sell") ||
        (quantity !== null && !(Number.isSafeInteger(quantity) && quantity > 0)) ||
        (limit !== null && !(limit > 0 && limit < 1))) return fail("Invalid liquidity parameters. Specify an outcome, positive whole quantity and a limit between zero and one dollar when applicable.", 400);
    liquidityQuery = { outcome, side, quantity, limit_price: limit };
  }
  const depth = liquidityQuery ? 0 : 1; // Gemini uses zero to request every displayed level.
  const [result, book] = await Promise.all([
    gPublic("/v1/prediction-markets/events/" + encodeURIComponent(ticker)),
    gPublic("/v1/book/" + encodeURIComponent(symbol), { limit_bids: depth, limit_asks: depth }),
  ]);
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
  const displayed_buy_quantity_at_ask = {
    yes: displayedBuySize(book.ok ? book.data?.asks?.[0] : undefined, contract.buy.yes, false),
    no: displayedBuySize(book.ok ? book.data?.bids?.[0] : undefined, contract.buy.no, true),
  };
  const now = Date.now();
  return Response.json({ ok: true, source: "Gemini Sandbox", as_of: new Date(now).toISOString(),
    event_ticker: ticker, title: event.title, contract, displayed_buy_quantity_at_ask, seconds_to_expiry: secondsUntil(contract.expiry, now),
    ...(liquidityQuery && { liquidity: liquiditySnapshot(book.ok ? book.data : null, liquidityQuery) }),
    payout_per_contract: { yes: payoutAtAsk(contract.buy.yes), no: payoutAtAsk(contract.buy.no) } });
}

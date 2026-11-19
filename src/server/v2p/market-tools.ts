import { dashboardMarkets, dashboardMarketsFrom } from "./dashboard-markets";
import { comboEligibility } from "./native-combo";
import { gPublic, geminiReadError, findContract, type GEvent } from "./gemini";
import { settlementIndex } from "./settlement-index";

import { normalizeMarketQuery, discoverCombos, fiveMinuteDiscovery, secondsUntil, payoutAtAsk } from "./prediction-discovery";

// Gemini quotes its binary book on the YES side. A resting YES bid at p
// supplies a NO buy at 1 - p. Only attach size if both snapshots agree.
function displayedBuySize(level: { price?: unknown; amount?: unknown } | undefined, quote: number | null, complement: boolean) {
  if (quote == null || !level) return null;
  const price = Number(level.price);
  const amount = Number(level.amount);
  if (!(price > 0 && price < 1 && Number.isFinite(amount) && amount > 0)) return null;
  return Math.abs((complement ? 1 - price : price) - quote) < 1e-9 ? amount : null;
}

// Keep the voice tool's single query parameter. Remove browse qualifiers before matching market names.
function browseQuery(raw: string) {
  let minVolume: number | null = null;
  let endingMinutes: number | null = null;
  let rankByVolume = false;
  let rankByExpiry = false;
  const words = raw.toLowerCase()
    .replace(/\b(?:min(?:imum)?\s+volume|volume\s+(?:at least|above|over|from))\s*\$?([\d,]+(?:\.\d+)?)\s*([km])?\b/g, (_, amount, suffix) => {
      minVolume = Number(amount.replaceAll(",", "")) * (suffix === "k" ? 1000 : suffix === "m" ? 1000000 : 1);
      return " ";
    })
    .replace(/\b(?:highest|high|most|top|by)\s+volume\b/g, () => { rankByVolume = true; return " "; })
    .replace(/\b(?:ending|closing|expiring)\s+(?:in|within)\s+(?:the next\s+)?(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/g, (_, value, unit) => {
      endingMinutes = Number(value) * (unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1440 : 1);
      rankByExpiry = true;
      return " ";
    })
    .replace(/\b(?:ending|closing|expiring)\s+(?:soonest|soon|first|next)\b/g, () => { rankByExpiry = true; return " "; });
  const browsing = minVolume !== null || rankByVolume || rankByExpiry;
  const keywords = browsing ? words.replace(/\b(?:please|show|me|the|markets?|events?|contracts?|with|and|sort|sorted|by)\b/g, " ") : words;
  return { query: normalizeMarketQuery(keywords), minVolume, endingMinutes, rankByVolume, rankByExpiry, browsing };
}

export async function marketTool(name: string, params: URLSearchParams) {
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  const fields = name === "search_markets" ? ["query"] : name === "get_settlement_index" ? ["event_ticker"] : ["event_ticker", "contract_symbol"];
  if (!["search_markets", "get_orderbook", "get_settlement_index"].includes(name)) return fail("Unknown market tool.", 404);
  if (Array.from(params.keys()).length !== fields.length || fields.some(k => !params.has(k) || params.get(k)!.length > 200))
    return fail("Invalid market tool parameters.", 400);
  if (name === "get_settlement_index") return settlementIndex(params.get("event_ticker")!);
  if (name === "search_markets") {
    const { query, minVolume, endingMinutes, rankByVolume, rankByExpiry, browsing } = browseQuery(params.get("query")!);
    const assets = [...new Set(query.match(/\b(?:btc|eth|sol|xrp)\b/g) ?? [])];
    try {
      if (/\b(?:combos?|parlays?)\b/.test(query)) return Response.json(await discoverCombos(query));
      if (!browsing && /\b05m\b/.test(query) && assets.length && query.split(/[\s,&+/]+/).every(
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
      if ((rankByVolume || minVolume !== null) && (event.volume_usd == null || event.volume_usd < (minVolume ?? 0))) return [];
      const title = [event.title, event.category, event.ticker].join(" ").toLowerCase();
      const contracts = event.contracts.filter(c => {
        const expiry = Date.parse(c.expiry ?? "");
        if (fiveMinute && !(c.status === "active" && c.market_state === "open" && expiry > now)) return false;
        if (rankByExpiry && !(expiry > now)) return false;
        if (endingMinutes !== null && expiry > now + endingMinutes * 60_000) return false;
        return words.every(w => (title + " " + c.symbol + " " + c.label).toLowerCase().includes(w));
      });
      if (rankByExpiry || fiveMinute) contracts.sort((a, b) => Date.parse(a.expiry!) - Date.parse(b.expiry!));
      return contracts.length ? [{ ...event, contracts: contracts.slice(0, 8) }] : [];
    });
    if (rankByVolume) matches.sort((a, b) => b.volume_usd! - a.volume_usd!);
    else if (fiveMinute || rankByExpiry) matches.sort((a, b) => Date.parse(a.contracts[0]!.expiry!) - Date.parse(b.contracts[0]!.expiry!));
    return Response.json({ ok: true, as_of: new Date().toISOString(), source: "Gemini Sandbox", events: matches.slice(0, 8), matched_events: matches.length });
  }
  const ticker = params.get("event_ticker")!;
  const symbol = params.get("contract_symbol")!;
  if (![ticker, symbol].every(v => /^[a-z0-9_.-]+$/i.test(v) && !/^\.+$/.test(v))) return fail("Invalid prediction contract identifier.", 400);
  const [result, book] = await Promise.all([
    gPublic("/v1/prediction-markets/events/" + encodeURIComponent(ticker)),
    gPublic("/v1/book/" + encodeURIComponent(symbol), { limit_bids: 1, limit_asks: 1 }),
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
    payout_per_contract: { yes: payoutAtAsk(contract.buy.yes), no: payoutAtAsk(contract.buy.no) } });
}

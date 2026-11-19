import type { NativeCombo } from "../../components/console/types";
import { dashboardMarketsFrom } from "./dashboard-markets";
import { geminiReadError, gPublic } from "./gemini";
import { eligibleComboLegs } from "./native-combo";

import { BUY_CUTOFF_MS } from "./util";

import { normalizeMarketQuery } from "../../lib/market-sort";
export { normalizeMarketQuery } from "../../lib/market-sort";

export function secondsUntil(expiry: string | null, now: number) {
  const timestamp = Date.parse(expiry ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : null;
}

export function payoutAtAsk(price: number | null) {
  if (price === null || price <= 0 || price >= 1) return null;
  return {
    cost_usd: price,
    winning_settlement_usd: 1,
    losing_settlement_usd: 0,
    winning_profit_before_fees_usd: Math.round((1 - price) * 100) / 100,
    maximum_loss_before_fees_usd: price,
  };
}

export async function fiveMinuteDiscovery(assets: string[], query: string) {
  const listings = await Promise.all(
    assets.map(async (asset) => {
      const series = asset.toUpperCase() + "05M";
      const result = await gPublic("/v1/prediction-markets/events", {
        status: "active",
        search: series,
        limit: 100,
      });
      if (!result.ok) throw new Error(geminiReadError(result));
      const events = dashboardMarketsFrom(result.data);
      if (!events) throw new Error("Invalid Gemini event response.");
      return { asset, series, events };
    }),
  );
  const now = Date.now();
  const windows = listings.map(({ asset, series, events }) => {
    const candidates = events
      .filter((e) => e.ticker.startsWith(series) && /^\d+$/.test(e.ticker.slice(series.length)))
      .flatMap((event) =>
        event.contracts.flatMap((contract) => {
          const seconds = secondsUntil(contract.expiry, now);
          if (
            contract.status !== "active" ||
            seconds === null ||
            seconds === 0 ||
            !["open", "post_only"].includes(contract.market_state ?? "")
          )
            return [];
          return [{ event: { ...event, contracts: [contract] }, seconds }];
        }),
      )
      .sort((a, b) => a.seconds - b.seconds);
    const current = candidates.find((c) => c.event.contracts[0]?.market_state === "open");
    const following = candidates.filter((c) => !current || c.seconds > current.seconds);
    const next = following[0];
    const selected = current;
    const timing = (w: typeof current) =>
      w
        ? {
            event_ticker: w.event.ticker,
            contract_symbol: w.event.contracts[0]!.symbol,
            title: w.event.title,
            label: w.event.contracts[0]!.label,
            expiry: w.event.contracts[0]!.expiry,
            seconds_to_expiry: w.seconds,
            market_state: w.event.contracts[0]!.market_state,
            buy_window_open: w.event.contracts[0]!.market_state === "open" && Date.parse(w.event.contracts[0]!.expiry!) - now > BUY_CUTOFF_MS,
          }
        : null;
    const direction = query.match(new RegExp("\\b" + asset + "\\s+(up|down|yes|no)\\b"))?.[1];
    // UP denotes YES only for Gemini's explicitly labelled Up contract.
    const directSide = direction === "yes" || direction === "no" ? direction : null;
    const tracked_outcome =
      selected?.event.contracts[0]?.label?.toLowerCase() === "up" && direction
        ? ["up", "yes"].includes(direction)
          ? "yes"
          : "no"
        : directSide;
    return {
      asset,
      tracked_outcome,
      current: timing(current),
      next_window: timing(next),
      imminent: !!current && Date.parse(current.event.contracts[0]!.expiry!) - now <= BUY_CUTOFF_MS,
      selected: selected?.event,
    };
  });
  const selected = windows.flatMap((w) => (w.selected ? [w.selected] : []));
  return {
    ok: true,
    source: "Gemini Sandbox",
    as_of: new Date(now).toISOString(),
    events: selected,
    matched_events: selected.length,
    track_group: query.includes("track") || assets.length > 1,
    timing: windows.map(({ selected: event, ...window }) => ({
      ...window,
      selected_event_ticker: event?.ticker ?? null,
    })),
  };
}

export async function discoverCombos(query: string) {
  const result = await gPublic("/v1/prediction-markets/combos", {
    status: "Active",
    instrumentRegistered: "true",
    limit: 100,
  });
  if (!result.ok) throw new Error(geminiReadError(result));
  const rows = result.data?.combos;
  if (!Array.isArray(rows)) throw new Error("Invalid Gemini combo response.");
  const words = query
    .replace(/\b(?:combos?|parlays?|and|on|the|with)\b/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const combos: NativeCombo[] = [];
  const now = Date.now();
  for (const row of rows) {
    const c = row?.contract;
    if (
      !c?.instrumentSymbol ||
      !c.eventTicker ||
      !c.contractName ||
      !Array.isArray(row.legs) ||
      !row.legs.length
    )
      continue;
    const legs: NativeCombo["legs"] = [];
    for (const item of row.legs) {
      const leg = item?.contract;
      if (!leg?.contractName || !["Yes", "No"].includes(item.requiredOutcome)) break;
      legs.push({
        title: leg.eventName || leg.category || null,
        label: leg.contractName,
        outcome: item.requiredOutcome,
        resolution: item.legOutcome ?? null,
      });
    }
    if (legs.length !== row.legs.length) continue;
    const haystack = normalizeMarketQuery(
      [
        c.contractName,
        ...legs.map((l) => l.title + " " + l.label),
        ...row.legs.map((l: { contract?: { eventTicker?: string } }) => l.contract?.eventTicker),
      ].join(" "),
    );
    if (words.every((word) => haystack.includes(word)))
      combos.push({
        event_ticker: c.eventTicker,
        symbol: c.instrumentSymbol,
        title: c.contractName,
        can_request_quote:
          c.contractStatus?.toLowerCase() === "active" &&
          !c.resolutionSide &&
          !c.resolvedAt &&
          Date.parse(c.expiryDate) > now &&
          eligibleComboLegs(row.legs, now),
        status: c.contractStatus ?? null,
        expiry: c.expiryDate ?? null,
        legs,
      });
  }
  combos.sort((a, b) => Number(b.can_request_quote) - Number(a.can_request_quote));
  return {
    ok: true,
    source: "Gemini Sandbox",
    as_of: new Date(now).toISOString(),
    combos: combos.slice(0, 8),
    matched_in_page: combos.length,
    listings_checked: rows.length,
    listing_only: true,
  };
}

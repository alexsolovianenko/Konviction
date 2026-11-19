import type { MarketEvent } from "../components/console/types";
import type { MarketSort } from "./market-sort";

export function marketRank(sort: MarketSort, event: MarketEvent, expiry: string | null): number | null {
  if (sort === "featured") return event.featured_rank ?? null;
  if (sort === "volume") return event.volume_usd ?? null;
  if (sort === "volume_24h") return event.volume_24h_usd ?? null;
  const time = Date.parse((sort === "newest" ? event.created_at : expiry) ?? "");
  return Number.isFinite(time) ? time : null;
}

export function compareMarketRanks(left: number | null, right: number | null, descending: boolean) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return descending ? right - left : left - right;
}

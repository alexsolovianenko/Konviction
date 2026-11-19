import type { MarketEvent, MarketContract } from "../../components/console/types";
import { gPublic } from "./gemini";

function spread(c: MarketContract, side: "yes" | "no") {
  const ask = c.buy[side],
    bid = c.sell[side];
  return c.market_state === "open" && ask !== null && bid !== null && ask >= bid
    ? ask - bid
    : Infinity;
}

// Compare visible two-sided quotes, then check the actual top level for the
// most competitive events. A missing book contributes no liquidity evidence.
export async function rankDiscovery(events: MarketEvent[], side: "yes" | "no") {
  const ranked = events
    .map((event) => {
      const best = event.contracts.reduce((a, b) => (spread(a, side) <= spread(b, side) ? a : b));
      return { event, best, spread: spread(best, side), depth: 0 };
    })
    .sort((a, b) => a.spread - b.spread || (b.event.volume_usd ?? 0) - (a.event.volume_usd ?? 0));
  const candidates = ranked.filter((r) => Number.isFinite(r.spread)).slice(0, 4);
  if (candidates.length > 1)
    await Promise.all(
      candidates.map(async (candidate) => {
        const { best } = candidate;
        const book = await gPublic("/v1/book/" + encodeURIComponent(best.symbol), {
          limit_asks: 1,
          limit_bids: 1,
        });
        const level = book.ok
          ? side === "yes"
            ? book.data?.asks?.[0]
            : book.data?.bids?.[0]
          : null;
        const price = side === "yes" ? Number(level?.price) : 1 - Number(level?.price);
        const size = Number(level?.amount);
        if (Number.isFinite(size) && size > 0 && Math.abs(price - best.buy[side]!) < 1e-9)
          candidate.depth = price * size;
      }),
    );
  // Depth only breaks ties within one tick of spread.
  ranked.sort(
    (a, b) =>
      Math.round(a.spread * 100) - Math.round(b.spread * 100) ||
      b.depth - a.depth ||
      (b.event.volume_usd ?? 0) - (a.event.volume_usd ?? 0),
  );
  return ranked.map((r) => r.event);
}

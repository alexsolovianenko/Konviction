// Paid research routing: DEX buy vs sell volume for exactly four Gemini crypto assets.
// An identified asset gets a paid QuickNode x402 route only when:
//  1. its symbol AND name both match one of ETH, BTC, SOL, XRP (no cross-coin substitution),
//  2. Konviction has verified pools and a fixed, allowlisted, read-only plan for it (dex/), and
//  3. QuickNode's live, free /networks list includes that network right now.
// Otherwise research is context-only and nothing is charged. A 402 alone proves nothing: QuickNode
// returns 402 for any path, including networks it does not serve.
import type { AssetIdentity } from "./asset";
import { QUICKNODE_BASE_URL } from "./config";
import { DEX_MARKETS, probeBody, type DexId, type DexMarket } from "./dex";

export type Route = {
  id: DexId;
  network: string; // QuickNode network slug
  chain: string;
  symbols: string[];
  names: string[];
  /** What is actually measured, in plain words. */
  measures: string;
  note?: string;
};

export const ROUTES: Route[] = [
  {
    id: "eth",
    network: "ethereum-mainnet",
    chain: "Ethereum",
    symbols: ["ETH"],
    names: ["ether", "ethereum"],
    measures: "Uniswap v3 WETH/USDC and WETH/USDT swaps",
  },
  {
    id: "btc",
    network: "ethereum-mainnet",
    chain: "Ethereum",
    symbols: ["BTC", "XBT"],
    names: ["bitcoin"],
    measures: "Uniswap v3 WBTC/USDC and WBTC/USDT swaps",
    note: "BTC is measured with Wrapped Bitcoin (WBTC) on Ethereum as a proxy.",
  },
  {
    id: "sol",
    network: "solana-mainnet",
    chain: "Solana",
    symbols: ["SOL"],
    names: ["solana"],
    measures: "Orca Whirlpool SOL/USDT swaps",
  },
  {
    id: "xrp",
    network: "xrp-mainnet",
    chain: "XRP Ledger",
    symbols: ["XRP"],
    names: ["xrp", "ripple"],
    measures: "XRP Ledger XRP/RLUSD AMM swaps",
  },
];

export const routeUrl = (r: Route) => `${QUICKNODE_BASE_URL}/${r.network}`;
export const marketFor = (r: Route): DexMarket => DEX_MARKETS[r.id];
/** Fixed unpaid probe body used to read the per-call price. */
export const routeBody = (r: Route) => probeBody(marketFor(r));
export const routeById = (id: string | null | undefined) => ROUTES.find((r) => r.id === id) ?? null;
export const resourceLabel = (r: Route) => `${r.network} · ${marketFor(r).methods.join(", ")}`;

const norm = (s: string | null) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

export type RouteDecision =
  { route: Route; limitation: null } | { route: null; limitation: string };

export function chooseRoute(asset: AssetIdentity, listed: string[] | null): RouteDecision {
  const label = `${asset.name ?? asset.symbol} (${asset.symbol})`;
  const bySymbol = ROUTES.filter((r) => r.symbols.includes(asset.symbol));
  const route = bySymbol.find((r) => r.names.includes(norm(asset.name)));
  if (!route)
    return {
      route: null,
      limitation: bySymbol.length
        ? `The market's asset name "${asset.name ?? "unknown"}" does not match ${bySymbol[0]!.symbols[0]}, so no paid research is offered to avoid using another coin's data.`
        : `Paid DEX buy/sell research covers ETH, BTC, SOL and XRP only, not ${label}. Showing Gemini market and settlement-index context only.`,
    };
  if (!listed)
    return {
      route: null,
      limitation:
        "QuickNode's supported-network list is unavailable right now, so paid research is paused. Nothing was charged.",
    };
  if (!listed.includes(route.network))
    return {
      route: null,
      limitation: `QuickNode x402 does not currently list ${route.network} for ${label}. Showing context only.`,
    };
  return { route, limitation: null };
}

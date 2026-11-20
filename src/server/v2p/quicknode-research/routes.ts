// Paid research routing. An identified asset gets a paid QuickNode x402 route only when:
//  1. its symbol AND name both match a chain whose native asset it is (no cross-coin substitution),
//  2. Konviction has a verified, fixed, read-only research method for that chain family, and
//  3. QuickNode's live, free /networks list includes that network right now.
// Otherwise research is context-only and nothing is charged. A 402 alone proves nothing: QuickNode
// returns 402 for any path, including networks it does not serve.
import {
  evmReport,
  solanaReport,
  utxoReport,
  xrplReport,
  type Family,
  type ResearchReport,
} from "./aggregate";
import type { AssetIdentity } from "./asset";
import { QUICKNODE_BASE_URL } from "./config";

export type Route = {
  id: string;
  network: string; // QuickNode network slug
  chain: string;
  family: Family;
  symbols: string[];
  names: string[];
  note?: string;
};

/** Chains whose native asset maps 1:1 to a coin and that have a verified read-only method. */
export const ROUTES: Route[] = [
  {
    id: "btc",
    network: "btc-mainnet",
    chain: "Bitcoin",
    family: "utxo",
    symbols: ["BTC", "XBT"],
    names: ["bitcoin"],
  },
  {
    id: "eth",
    network: "ethereum-mainnet",
    chain: "Ethereum",
    family: "evm",
    symbols: ["ETH"],
    names: ["ether", "ethereum"],
  },
  {
    id: "sol",
    network: "solana-mainnet",
    chain: "Solana",
    family: "solana",
    symbols: ["SOL"],
    names: ["solana"],
  },
  {
    id: "xrp",
    network: "xrp-mainnet",
    chain: "XRP Ledger",
    family: "xrpl",
    symbols: ["XRP"],
    names: ["xrp", "ripple"],
  },
  {
    id: "hype",
    network: "hype-mainnet",
    chain: "HyperEVM",
    family: "evm",
    symbols: ["HYPE"],
    names: ["hyperliquid", "hype"],
    note: "HyperEVM block data only; it does not cover HyperCore order-book activity.",
  },
  {
    id: "ltc",
    network: "ltc-mainnet",
    chain: "Litecoin",
    family: "utxo",
    symbols: ["LTC"],
    names: ["litecoin"],
  },
  {
    id: "doge",
    network: "doge-mainnet",
    chain: "Dogecoin",
    family: "utxo",
    symbols: ["DOGE"],
    names: ["dogecoin"],
  },
  {
    id: "bch",
    network: "bch-mainnet",
    chain: "Bitcoin Cash",
    family: "utxo",
    symbols: ["BCH"],
    names: ["bitcoin cash"],
  },
  {
    id: "bnb",
    network: "bsc-mainnet",
    chain: "BNB Smart Chain",
    family: "evm",
    symbols: ["BNB"],
    names: ["bnb", "binance coin"],
  },
  {
    id: "pol",
    network: "matic-mainnet",
    chain: "Polygon PoS",
    family: "evm",
    symbols: ["POL", "MATIC"],
    names: ["polygon", "pol", "matic"],
  },
];

const BODIES: Record<Family, string> = {
  solana: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getRecentPerformanceSamples",
    params: [120],
  }),
  evm: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_feeHistory",
    params: ["0x78", "latest", []],
  }),
  utxo: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getmempoolinfo", params: [] }),
  xrpl: JSON.stringify({ method: "fee", params: [{}] }),
};

export const routeUrl = (r: Route) => `${QUICKNODE_BASE_URL}/${r.network}`;
export const routeBody = (r: Route) => BODIES[r.family];
export const routeById = (id: string | null | undefined) => ROUTES.find((r) => r.id === id) ?? null;
export const resourceLabel = (r: Route) => `${r.network} · ${JSON.parse(BODIES[r.family]).method}`;

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
        ? `The market's asset name "${asset.name ?? "unknown"}" does not match the ${bySymbol[0]!.chain} network for ${asset.symbol}, so no paid research is offered to avoid using another coin's data.`
        : `No supported paid QuickNode x402 research source for ${label}. Showing Gemini market and settlement-index context only.`,
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

/** Parse a paid response for a route. Distinguishes JSON-RPC errors from data. */
export function readRoute(
  route: Route,
  text: string,
  at: Date,
): { report: ResearchReport | null; rpcError: string | null } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { report: null, rpcError: "Response was not JSON." };
  }
  if (j["error"]) {
    const e = (typeof j["error"] === "object" ? j["error"] : { message: j["error"] }) as Record<
      string,
      unknown
    >;
    return {
      report: null,
      rpcError:
        `JSON-RPC error ${String(e["code"] ?? "")} ${String(e["message"] ?? "").slice(0, 120)}`
          .replace(/\s+/g, " ")
          .trim(),
    };
  }
  if (!("result" in j)) return { report: null, rpcError: "JSON-RPC response had no result." };
  const result = j["result"];
  if (route.family === "xrpl") {
    const res = (result ?? {}) as Record<string, unknown>;
    if (res["status"] === "error")
      return { report: null, rpcError: `XRPL error ${String(res["error"] ?? "").slice(0, 80)}` };
  }
  const build: Record<Family, (r: unknown, at: Date, chain: string) => ResearchReport> = {
    solana: solanaReport,
    evm: evmReport,
    utxo: utxoReport,
    xrpl: xrplReport,
  };
  const report = build[route.family](result, at, route.chain);
  if (route.note) report.warnings.push(route.note);
  return { report, rpcError: null };
}

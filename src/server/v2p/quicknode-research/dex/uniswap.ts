// Ethereum mainnet Uniswap V3 Swap logs for WETH (ETH) and WBTC (wrapped-BTC proxy) against USDC/USDT.
// Pools were verified on 2026-11-20 with read-only eth_call: factory() is the Uniswap V3 factory
// 0x1F98431c8aD98523631AE4a59f267346ea31F984, and token0/token1/fee match the entries below.
import type { PoolRef, ReportInput } from "./report";
import { pool, RpcFailure, type Rpc } from "./rpc";
import { int256, TIMEFRAME_SECONDS, units, type SwapLeg, type Timeframe } from "./volume";

/** keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") */
export const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const SECONDS_PER_BLOCK = 12;

export type EvmPool = {
  address: string;
  pair: string;
  /** Which of token0/token1 is the researched asset. */
  assetIndex: 0 | 1;
  assetDecimals: number;
  stableDecimals: number;
};

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
export const TOKENS = { USDC, USDT, WETH, WBTC };

export type EvmMarket = {
  id: "eth" | "btc";
  asset: string;
  assetNote: string | null;
  pools: EvmPool[];
  /** Max blocks per eth_getLogs call; sized so one response stays well under the body limit. */
  chunkBlocks: number;
};

export const ETH_MARKET: EvmMarket = {
  id: "eth",
  asset: "ETH",
  assetNote: null,
  chunkBlocks: 300,
  pools: [
    // token0 USDC (6), token1 WETH (18)
    {
      address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      pair: "WETH/USDC 0.05%",
      assetIndex: 1,
      assetDecimals: 18,
      stableDecimals: 6,
    },
    {
      address: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
      pair: "WETH/USDC 0.3%",
      assetIndex: 1,
      assetDecimals: 18,
      stableDecimals: 6,
    },
    // token0 WETH (18), token1 USDT (6)
    {
      address: "0x11b815efb8f581194ae79006d24e0d814b7697f6",
      pair: "WETH/USDT 0.05%",
      assetIndex: 0,
      assetDecimals: 18,
      stableDecimals: 6,
    },
    {
      address: "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36",
      pair: "WETH/USDT 0.3%",
      assetIndex: 0,
      assetDecimals: 18,
      stableDecimals: 6,
    },
  ],
};

export const BTC_MARKET: EvmMarket = {
  id: "btc",
  asset: "BTC",
  assetNote:
    "Measured with Wrapped Bitcoin (WBTC) on Ethereum as a proxy; native Bitcoin has no DEX swaps.",
  chunkBlocks: 1800,
  pools: [
    // token0 WBTC (8), token1 USDC/USDT (6)
    {
      address: "0x99ac8ca7087fa4a2a1fb6357269965a2014abc35",
      pair: "WBTC/USDC 0.3%",
      assetIndex: 0,
      assetDecimals: 8,
      stableDecimals: 6,
    },
    {
      address: "0x9a772018fbd77fcd2d25657e5c547baff3fd7d16",
      pair: "WBTC/USDC 0.05%",
      assetIndex: 0,
      assetDecimals: 8,
      stableDecimals: 6,
    },
    {
      address: "0x9db9e0e53058c89e5b94e29621a205198648425b",
      pair: "WBTC/USDT 0.3%",
      assetIndex: 0,
      assetDecimals: 8,
      stableDecimals: 6,
    },
  ],
};

// One extra block so the first block is at least the full window older than the head.
const blocksFor = (tf: Timeframe) => Math.ceil(TIMEFRAME_SECONDS[tf] / SECONDS_PER_BLOCK) + 1;

/** Exact paid-call plan: latest header + window-start header + one eth_getLogs per chunk. */
export function evmMaxCalls(m: EvmMarket, tf: Timeframe): number {
  return 2 + Math.ceil(blocksFor(tf) / m.chunkBlocks);
}

const HEX = /^0x[0-9a-f]{1,16}$/;
const hexNum = (v: unknown): number | null =>
  typeof v === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(v) ? Number.parseInt(v, 16) : null;
const toHex = (n: number) => "0x" + n.toString(16);

export function evmAllowed(m: EvmMarket) {
  const addrs = m.pools.map((p) => p.address).sort();
  return (method: string, params: unknown): boolean => {
    if (!Array.isArray(params)) return false;
    if (method === "eth_getBlockByNumber")
      return (
        params.length === 2 &&
        params[1] === false &&
        (params[0] === "latest" || (typeof params[0] === "string" && HEX.test(params[0])))
      );
    if (method === "eth_getLogs") {
      if (params.length !== 1 || !params[0] || typeof params[0] !== "object") return false;
      const f = params[0] as Record<string, unknown>;
      if (Object.keys(f).sort().join() !== "address,fromBlock,toBlock,topics") return false;
      const from =
        typeof f["fromBlock"] === "string" && HEX.test(f["fromBlock"])
          ? hexNum(f["fromBlock"])
          : null;
      const to =
        typeof f["toBlock"] === "string" && HEX.test(f["toBlock"]) ? hexNum(f["toBlock"]) : null;
      if (from === null || to === null || to < from || to - from + 1 > m.chunkBlocks) return false;
      const a = f["address"];
      if (!Array.isArray(a) || [...a].sort().join() !== addrs.join()) return false;
      const t = f["topics"];
      return Array.isArray(t) && t.length === 1 && t[0] === SWAP_TOPIC;
    }
    return false;
  };
}

type Log = Record<string, unknown>;

/** Decode one Uniswap V3 Swap log into a swap leg from the asset's perspective. Null = not a swap of ours. */
export function decodeSwapLog(
  log: Log,
  pools: Map<string, EvmPool>,
  timeOf: (block: number, log: Log) => number,
): SwapLeg | null {
  if (log["removed"] === true) return null;
  const p = pools.get(String(log["address"] ?? "").toLowerCase());
  if (!p) return null; // unsupported pool
  const topics = log["topics"];
  if (!Array.isArray(topics) || topics[0] !== SWAP_TOPIC) return null;
  const data = String(log["data"] ?? "");
  if (!/^0x[0-9a-fA-F]{320}$/.test(data)) return null;
  const block = hexNum(log["blockNumber"]);
  const tx =
    typeof log["transactionHash"] === "string" ? log["transactionHash"].toLowerCase() : null;
  const idx = hexNum(log["logIndex"]);
  if (block === null || !tx || idx === null) return null;
  // Amounts are the POOL's balance change: positive = pool received that token.
  const a0 = int256(data.slice(2, 66));
  const a1 = int256(data.slice(66, 130));
  if (a0 === 0n || a1 === 0n || a0 > 0n === a1 > 0n) return null; // not a two-sided swap
  const poolAsset = p.assetIndex === 0 ? a0 : a1;
  const poolStable = p.assetIndex === 0 ? a1 : a0;
  return {
    tx,
    leg: String(idx),
    time: timeOf(block, log),
    asset: -units(poolAsset, p.assetDecimals), // trader receives what the pool sends
    usd: Math.abs(units(poolStable, p.stableDecimals)),
    pool: p.address,
  };
}

type Header = { number: number; timestamp: number };
const header = (raw: unknown): Header => {
  const o = (raw ?? {}) as Record<string, unknown>;
  const number = hexNum(o["number"]);
  const timestamp = hexNum(o["timestamp"]);
  if (number === null || timestamp === null)
    throw new RpcFailure("parse", "Block header missing number or timestamp.");
  return { number, timestamp };
};

export async function runEvm(
  m: EvmMarket,
  tf: Timeframe,
  rpc: Rpc,
): Promise<Omit<ReportInput, "callsUsed" | "observedAt">> {
  const seconds = TIMEFRAME_SECONDS[tf];
  const warnings: string[] = [];
  const pools: PoolRef[] = m.pools.map((p) => ({
    dex: "Uniswap v3",
    pair: p.pair,
    address: p.address,
    url: `https://etherscan.io/address/${p.address}`,
  }));
  const common = {
    asset: m.asset,
    assetNote: m.assetNote,
    chain: "Ethereum",
    source: "QuickNode x402 ethereum-mainnet",
    method: "eth_getLogs (Uniswap V3 Swap events)",
    timeframe: tf,
    pools,
    coverage: `Uniswap v3 ${m.pools.map((p) => p.pair).join(", ")} only. Other DEXs, Uniswap v4 and centralized exchanges are not included.`,
    txUrl: (h: string) => `https://etherscan.io/tx/${h}`,
    poolTxCount: null,
  };
  let head: Header;
  try {
    head = header(await rpc("eth_getBlockByNumber", ["latest", false]));
  } catch (e) {
    return {
      ...common,
      window: null,
      complete: false,
      legs: [],
      warnings: [`Latest block unavailable: ${(e as Error).message}`],
    };
  }
  const n = blocksFor(tf);
  const startBlock = head.number - n + 1;
  const chunks: Array<[number, number]> = [];
  for (let to = head.number; to >= startBlock; to -= m.chunkBlocks)
    chunks.push([Math.max(startBlock, to - m.chunkBlocks + 1), to]);

  const byAddr = new Map(m.pools.map((p) => [p.address, p]));
  let estimated = false;
  let failed = false;
  const startHeader = rpc("eth_getBlockByNumber", [toHex(startBlock), false]).then(
    header,
    () => null,
  );
  const results = await pool(
    chunks,
    3,
    async ([from, to]) => {
      try {
        const logs = await rpc("eth_getLogs", [
          {
            fromBlock: toHex(from),
            toBlock: toHex(to),
            address: m.pools.map((p) => p.address),
            topics: [SWAP_TOPIC],
          },
        ]);
        if (!Array.isArray(logs)) throw new RpcFailure("parse", "eth_getLogs returned no list.");
        return logs as Log[];
      } catch (e) {
        failed = true;
        throw e;
      }
    },
    () => failed,
  );
  const start = await startHeader;
  // Keep only the contiguous run of successful chunks from the newest block backwards.
  let covered = 0;
  while (covered < results.length && results[covered]?.ok) covered++;
  if (covered < chunks.length) {
    const bad = results.find((r) => r && !r.ok) as { ok: false; error: unknown } | undefined;
    warnings.push(
      `Only ${covered} of ${chunks.length} block ranges were retrieved${bad ? ` (${(bad.error as Error).message})` : ""}. Totals cover the retrieved span only.`,
    );
  }
  if (covered === 0) return { ...common, window: null, complete: false, legs: [], warnings };
  const lowBlock = chunks[covered - 1]![0];
  // Ethereum blocks can skip 12-second slots, so `head - 12 * blockDistance` can assign
  // historical swaps to the WRONG time window (especially over 24 hours). Anchor estimates
  // to the two actual header timestamps instead. Individual log times remain approximate.
  const estimate = (b: number) =>
    start && head.number > start.number
      ? Math.round(
          start.timestamp +
            ((b - start.number) / (head.number - start.number)) *
              (head.timestamp - start.timestamp),
        )
      : head.timestamp - (head.number - b) * SECONDS_PER_BLOCK;
  const lowTime = lowBlock === startBlock && start ? start.timestamp : estimate(lowBlock);
  const timeOf = (b: number, log: Log) => {
    const t = hexNum(log["blockTimestamp"]);
    if (t !== null) return t;
    estimated = true;
    return b === head.number ? head.timestamp : estimate(b);
  };
  const legs: SwapLeg[] = [];
  let skipped = 0;
  for (let i = 0; i < covered; i++) {
    const [from, to] = chunks[i]!;
    for (const log of (results[i] as { ok: true; value: Log[] }).value) {
      const b = hexNum(log["blockNumber"]);
      if (b === null || b < from || b > to) continue; // outside the requested range
      const leg = decodeSwapLog(log, byAddr, timeOf);
      if (leg) legs.push(leg);
      else skipped++;
    }
  }
  if (skipped)
    warnings.push(`${skipped} logs were not two-sided swaps on the listed pools and were ignored.`);
  if (estimated)
    warnings.push("Individual swap timestamps were estimated between block headers, so swaps near the lookback boundary may be misclassified when slots were missed.");
  if (!start && lowBlock === startBlock)
    warnings.push("The historical start block timestamp was unavailable; timing and window coverage are approximate.");
  const from = Math.max(lowTime, head.timestamp - seconds);
  return {
    ...common,
    window: { from, to: head.timestamp },
    complete: covered === chunks.length && start !== null,
    legs,
    warnings,
  };
}

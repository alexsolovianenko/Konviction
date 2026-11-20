// The four supported DEX research markets. Each has a fixed QuickNode network, a fixed allowlist of
// read-only methods/params, an exact upper bound on paid calls per timeframe, and a runner.
import { buildReport, type ResearchReport } from "./report";
import { makeRpc, type Flavor, type Send } from "./rpc";
import { runSolana, solAllowed, solMaxCalls } from "./solana";
import { BTC_MARKET, ETH_MARKET, evmAllowed, evmMaxCalls, runEvm } from "./uniswap";
import type { Timeframe } from "./volume";
import { runXrpl, xrplAllowed, xrplMaxCalls } from "./xrpl";

export type DexId = "eth" | "btc" | "sol" | "xrp";

export type DexMarket = {
  id: DexId;
  network: string;
  flavor: Flavor;
  methods: string[];
  /** Fixed, free-of-meaning body used only for the unpaid 402 price probe. */
  probe: { method: string; params: unknown };
  maxCalls: (tf: Timeframe) => number;
  allowed: (method: string, params: unknown) => boolean;
  run: (
    tf: Timeframe,
    rpc: ReturnType<typeof makeRpc>["rpc"],
    nowMs: number,
  ) => ReturnType<typeof runEvm>;
};

const ethAllowed = evmAllowed(ETH_MARKET);
const btcAllowed = evmAllowed(BTC_MARKET);
const evmProbe = { method: "eth_getBlockByNumber", params: ["latest", false] };

export const DEX_MARKETS: Record<DexId, DexMarket> = {
  eth: {
    id: "eth",
    network: "ethereum-mainnet",
    flavor: "jsonrpc",
    methods: ["eth_getBlockByNumber", "eth_getLogs"],
    probe: evmProbe,
    maxCalls: (tf) => evmMaxCalls(ETH_MARKET, tf),
    allowed: ethAllowed,
    run: (tf, rpc) => runEvm(ETH_MARKET, tf, rpc),
  },
  btc: {
    id: "btc",
    network: "ethereum-mainnet",
    flavor: "jsonrpc",
    methods: ["eth_getBlockByNumber", "eth_getLogs"],
    probe: evmProbe,
    maxCalls: (tf) => evmMaxCalls(BTC_MARKET, tf),
    allowed: btcAllowed,
    run: (tf, rpc) => runEvm(BTC_MARKET, tf, rpc),
  },
  sol: {
    id: "sol",
    network: "solana-mainnet",
    flavor: "jsonrpc",
    methods: ["getSignaturesForAddress", "getTransaction"],
    probe: {
      method: "getSignaturesForAddress",
      params: [
        "FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC",
        { limit: 1000, commitment: "confirmed" },
      ],
    },
    maxCalls: solMaxCalls,
    allowed: solAllowed,
    run: (tf, rpc, now) => runSolana(tf, rpc, now),
  },
  xrp: {
    id: "xrp",
    network: "xrp-mainnet",
    flavor: "xrpl",
    methods: ["account_tx"],
    probe: {
      method: "account_tx",
      params: {
        account: "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3",
        limit: 200,
        forward: false,
        ledger_index_min: -1,
        ledger_index_max: -1,
      },
    },
    maxCalls: xrplMaxCalls,
    allowed: xrplAllowed,
    run: (tf, rpc, now) => runXrpl(tf, rpc, now),
  },
};

/** The exact JSON body for a market's unpaid price probe (also allowlisted, so it can be paid). */
export function probeBody(m: DexMarket): string {
  return m.flavor === "xrpl"
    ? JSON.stringify({ method: m.probe.method, params: [m.probe.params] })
    : JSON.stringify({ jsonrpc: "2.0", id: 1, method: m.probe.method, params: m.probe.params });
}

/** True only for a JSON body this market may send (method and params allowlisted). */
export function bodyAllowed(m: DexMarket, body: string): boolean {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (m.flavor === "xrpl") {
      const p = j["params"];
      return (
        Object.keys(j).sort().join() === "method,params" &&
        Array.isArray(p) &&
        p.length === 1 &&
        m.allowed(String(j["method"]), p[0])
      );
    }
    return (
      Object.keys(j).sort().join() === "id,jsonrpc,method,params" &&
      j["jsonrpc"] === "2.0" &&
      m.allowed(String(j["method"]), j["params"])
    );
  } catch {
    return false;
  }
}

/** Run one market's plan over `send`, never exceeding its call bound. */
export async function runDex(
  m: DexMarket,
  tf: Timeframe,
  send: Send,
  nowMs = Date.now(),
): Promise<{ report: ResearchReport; calls: number }> {
  const { rpc, used } = makeRpc({
    flavor: m.flavor,
    send,
    allowed: m.allowed,
    maxCalls: m.maxCalls(tf),
  });
  const input = await m.run(tf, rpc, nowMs);
  const report = buildReport({ ...input, callsUsed: used(), observedAt: new Date(nowMs) });
  return { report, calls: used() };
}

// Verify the DEX buy/sell decoders against REAL mainnet data over FREE public RPC endpoints.
// Never contacts QuickNode, never signs, never pays. Uses the exact same allowlisted plans as the
// paid path, only with a different transport.
//
//   npx tsx scripts/dex-research-verify.ts                 # all four assets, 5m
//   npx tsx scripts/dex-research-verify.ts --asset=eth --timeframe=1h
//
// Override endpoints with DEX_VERIFY_ETH_RPC / DEX_VERIFY_SOL_RPC / DEX_VERIFY_XRP_RPC.
import {
  bodyAllowed,
  DEX_MARKETS,
  runDex,
  type DexId,
} from "../src/server/v2p/quicknode-research/dex/index.ts";
import { isTimeframe, type Timeframe } from "../src/server/v2p/quicknode-research/dex/volume.ts";

const RPC: Record<string, string> = {
  "ethereum-mainnet": process.env["DEX_VERIFY_ETH_RPC"] ?? "https://ethereum-rpc.publicnode.com",
  "solana-mainnet": process.env["DEX_VERIFY_SOL_RPC"] ?? "https://api.mainnet-beta.solana.com",
  "xrp-mainnet": process.env["DEX_VERIFY_XRP_RPC"] ?? "https://xrplcluster.com/",
};
const argv = process.argv.slice(2);
const opt = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tfArg = opt("timeframe") ?? "5m";
if (!isTimeframe(tfArg)) throw new Error("timeframe must be 5m, 15m, 1h or 24h");
const tf: Timeframe = tfArg;
const ids = (opt("asset") ? [opt("asset")] : ["eth", "btc", "sol", "xrp"]) as DexId[];

for (const id of ids) {
  const m = DEX_MARKETS[id];
  if (!m) throw new Error(`unknown asset ${id}`);
  let bytes = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const send = async (body: string) => {
    if (!bodyAllowed(m, body)) throw new Error("refused: body not allowlisted");
    // Public Solana RPC rate-limits bursts: serialize and space requests out.
    if (m.network === "solana-mainnet") {
      const turn = queue.then(() => new Promise((r) => setTimeout(r, 400)));
      queue = turn;
      await turn;
    }
    const res = await fetch(RPC[m.network]!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    bytes += text.length;
    return { status: res.status, text };
  };
  const t0 = Date.now();
  const { report: r, calls } = await runDex(m, tf, send);
  console.log(
    `\n=== ${id.toUpperCase()} ${tf} via ${RPC[m.network]} (${calls} calls of max ${m.maxCalls(tf)}, ${(bytes / 1e6).toFixed(2)} MB, ${Date.now() - t0} ms)`,
  );
  console.log(r.headline);
  console.log({
    completeness: r.completeness,
    measured: `${r.measured_from} → ${r.measured_to} (${r.measured_seconds}s of ${r.requested_seconds}s)`,
    buy_usd: r.buy_usd,
    sell_usd: r.sell_usd,
    net_buy_usd: r.net_buy_usd,
    buy_pct: r.buy_pct,
    trades: r.trade_count,
    pool_txs: r.pool_tx_count,
    last_trade_at: r.last_trade_at,
  });
  for (const x of r.examples)
    console.log(`  ${x.side.padEnd(4)} $${x.usd.toFixed(2).padStart(12)}  ${x.at}  ${x.url}`);
  if (r.warnings.length) console.log("  warnings:", r.warnings);
}

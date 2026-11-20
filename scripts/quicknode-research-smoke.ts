// QuickNode x402 DEX research smoke test. READ-ONLY BY DEFAULT.
//
//   npx tsx scripts/quicknode-research-smoke.ts                       # every route: listed? unpaid quote valid? cost per timeframe
//   npx tsx scripts/quicknode-research-smoke.ts --route=eth --balance # + Gateway balance (needs key, no spend)
//   QUICKNODE_SMOKE_ALLOW_PAYMENT=I_ACCEPT_TESTNET_SPEND \
//   npx tsx scripts/quicknode-research-smoke.ts --route=eth --timeframe=5m --pay
//       # ONE research request: at most the quoted number of paid calls, each capped at the quote
//
// The key is read only from RESEARCH_WALLET_PRIVATE_KEY in the environment of the person running it.
// It is never printed, written or sent anywhere except the QuickNode SDK in this process.
import {
  formatUsdc,
  QUICKNODE_BASE_URL,
  QUICKNODE_NETWORKS_URL,
  researchConfig,
} from "../src/server/v2p/quicknode-research/config.ts";
import { bodyAllowed, runDex } from "../src/server/v2p/quicknode-research/dex/index.ts";
import { isTimeframe, TIMEFRAMES } from "../src/server/v2p/quicknode-research/dex/volume.ts";
import { runPaidSession } from "../src/server/v2p/quicknode-research/paid-request.ts";
import {
  marketFor,
  routeBody,
  routeById,
  ROUTES,
  routeUrl,
  type Route,
} from "../src/server/v2p/quicknode-research/routes.ts";
import {
  parsePaymentRequired,
  selectLikeSdk,
  validateRequirement,
} from "../src/server/v2p/quicknode-research/x402.ts";

const argv = process.argv.slice(2);
const args = new Set(argv);
const routeId = argv.find((a) => a.startsWith("--route="))?.slice(8) ?? null;
const tfArg = argv.find((a) => a.startsWith("--timeframe="))?.slice(12) ?? "5m";
if (!isTimeframe(tfArg)) throw new Error("--timeframe must be 5m, 15m, 1h or 24h");
const cfg = researchConfig();

const listed = ((await (await fetch(QUICKNODE_NETWORKS_URL)).json()) as { networks: string[] })
  .networks;

async function quote(route: Route) {
  const url = routeUrl(route);
  if (!listed.includes(route.network))
    return (console.log(`${route.id}: ${route.network} NOT listed by QuickNode`), null);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: routeBody(route),
    redirect: "manual",
  });
  const text = await res.text();
  if (res.status !== 402) return (console.log(`${route.id}: unexpected HTTP ${res.status}`), null);
  const pr = parsePaymentRequired(res.headers.get("payment-required"), text);
  const r = validateRequirement(selectLikeSdk(pr.accepts, cfg.network), cfg, pr.resourceUrl, url);
  const costs = TIMEFRAMES.map((tf) => {
    const n = marketFor(route).maxCalls(tf);
    return `${tf}: ≤${n} calls ≤${formatUsdc(BigInt(r.amount) * BigInt(n))}`;
  }).join(" · ");
  console.log(
    `${route.id}: ${route.network} listed · ${formatUsdc(r.amount)} USDC per call on ${r.network} → ${r.payTo}\n    ${costs}`,
  );
  return r;
}

if (!routeId) {
  for (const r of ROUTES)
    await quote(r).catch((e) => console.log(`${r.id}: refused (${(e as Error).message})`));
  process.exit(0);
}
const route = routeById(routeId);
if (!route) throw new Error(`Unknown route ${routeId}`);
const quoted = await quote(route);

if (args.has("--balance") || args.has("--pay")) {
  const key = (process.env["RESEARCH_WALLET_PRIVATE_KEY"] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("RESEARCH_WALLET_PRIVATE_KEY is not set in this shell.");
  const { createQuicknodeX402Client, createEvmSigners } = await import("@quicknode/x402");
  const address = createEvmSigners(key as `0x${string}`).address;
  if (cfg.expectedSender && address.toLowerCase() !== cfg.expectedSender)
    throw new Error("Key does not match QUICKNODE_RESEARCH_WALLET_ADDRESS.");
  const c = await createQuicknodeX402Client({
    baseUrl: QUICKNODE_BASE_URL,
    network: cfg.network,
    evmPrivateKey: key as `0x${string}`,
    paymentModel: "nanopayment",
  });
  console.log("Research wallet (public):", address);
  console.log(
    "Gateway available:",
    formatUsdc((await c.gatewayClient!.getBalances()).gateway.available),
    "testnet USDC",
  );
  if (args.has("--pay")) {
    if (process.env["QUICKNODE_SMOKE_ALLOW_PAYMENT"] !== "I_ACCEPT_TESTNET_SPEND")
      throw new Error("Refusing to pay: set QUICKNODE_SMOKE_ALLOW_PAYMENT=I_ACCEPT_TESTNET_SPEND.");
    if (!quoted) throw new Error("No paid quote to approve.");
    const market = marketFor(route);
    const maxCalls = market.maxCalls(tfArg);
    if (BigInt(quoted.amount) * BigInt(maxCalls) > cfg.maxPerRequest)
      throw new Error("Estimated cost exceeds the per-request cap.");
    console.log(
      `Paying for ONE ${route.id} ${tfArg} research request: up to ${maxCalls} calls, at most ${formatUsdc(BigInt(quoted.amount) * BigInt(maxCalls))} USDC`,
    );
    const out = await runPaidSession({
      cfg,
      key: key as `0x${string}`,
      quoted,
      url: routeUrl(route),
      maxCalls,
      allowBody: (b) => bodyAllowed(market, b),
      factory: async () => c as never,
      beforeSend: async () => undefined,
      work: (send) => runDex(market, tfArg, send),
    });
    console.log(
      `${out.callsSent} sent · ${out.callsOk} HTTP 200 · ${out.signedCount} payments created · ${out.apiMs} ms`,
    );
    console.log(out.result?.report.headline ?? out.error);
    if (out.availableBefore !== null && out.availableAfter !== null)
      console.log(
        `Gateway available: ${formatUsdc(out.availableBefore)} → ${formatUsdc(out.availableAfter)} (observed deduction ${formatUsdc(out.availableBefore - out.availableAfter)}). Gateway settles on-chain in batches.`,
      );
  }
}

// QuickNode x402 research smoke test. READ-ONLY BY DEFAULT.
//
//   npx tsx scripts/quicknode-research-smoke.ts                    # every route: listed? unpaid quote valid?
//   npx tsx scripts/quicknode-research-smoke.ts --route=btc --balance   # + Gateway balance (needs key, no spend)
//   QUICKNODE_SMOKE_ALLOW_PAYMENT=I_ACCEPT_TESTNET_SPEND \
//   npx tsx scripts/quicknode-research-smoke.ts --route=btc --pay  # ONE paid request, capped at the quote
//
// The key is read only from RESEARCH_WALLET_PRIVATE_KEY in the environment of the person running it.
// It is never printed, written or sent anywhere except the QuickNode SDK in this process.
import {
  formatUsdc,
  QUICKNODE_BASE_URL,
  QUICKNODE_NETWORKS_URL,
  researchConfig,
} from "../src/server/v2p/quicknode-research/config.ts";
import {
  readRoute,
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
  if (res.status === 200)
    return (console.log(`${route.id}: unpaid probe returned 200 (free)`), null);
  if (res.status !== 402) return (console.log(`${route.id}: unexpected HTTP ${res.status}`), null);
  const pr = parsePaymentRequired(res.headers.get("payment-required"), text);
  const r = validateRequirement(selectLikeSdk(pr.accepts, cfg.network), cfg, pr.resourceUrl, url);
  console.log(
    `${route.id}: ${route.network} listed · unpaid quote ${formatUsdc(r.amount)} USDC on ${r.network} → ${r.payTo}`,
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
  const available = async () => (await c.gatewayClient!.getBalances()).gateway.available;
  const before = await available();
  console.log("Gateway available:", formatUsdc(before), "testnet USDC");
  if (args.has("--pay")) {
    if (process.env["QUICKNODE_SMOKE_ALLOW_PAYMENT"] !== "I_ACCEPT_TESTNET_SPEND")
      throw new Error("Refusing to pay: set QUICKNODE_SMOKE_ALLOW_PAYMENT=I_ACCEPT_TESTNET_SPEND.");
    if (!quoted) throw new Error("No paid quote to approve.");
    c.x402Client.setSpendControls({
      allowedAssets: [
        { network: cfg.network, asset: cfg.asset, maxAmountPerPayment: quoted.amount },
      ],
    });
    const t0 = Date.now();
    const res = await c.fetch(routeUrl(route), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: routeBody(route),
    });
    const text = await res.text();
    console.log(
      `HTTP ${res.status} in ${Date.now() - t0} ms · payment-response header ${res.headers.get("payment-response") ? "present" : "absent"}`,
    );
    const { report, rpcError } = readRoute(route, text, new Date());
    console.log(rpcError ?? report?.headline);
    const after = await available();
    console.log(
      `Gateway available: ${formatUsdc(before)} → ${formatUsdc(after)} (observed deduction ${formatUsdc(before - after)}). Gateway settles on-chain in batches.`,
    );
  }
}

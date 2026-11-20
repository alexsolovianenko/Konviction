// Standalone Arc research test, outside the app and the trade engine.
//
//   npx tsx scripts/arc-research-smoke.ts                     # free: unpaid 402 probe + Gemini market + wallet balance
//   npx tsx scripts/arc-research-smoke.ts --new-wallet        # writes a fresh key to .arc-research-key (gitignored), prints address only
//   ARC_RESEARCH_PAYMENTS=true ARC_CONFIRM_SPEND=YES \
//     npx tsx scripts/arc-research-smoke.ts --pay [EVENT_TICKER]   # ONE real $0.0085 payment on Arc mainnet
//
// The key is read from ARC_RESEARCH_PRIVATE_KEY or .arc-research-key. It is never printed.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const args = process.argv.slice(2);
const pay = args.includes("--pay");
const keyFile = ".arc-research-key";

if (args.includes("--new-wallet")) {
  if (existsSync(keyFile)) {
    console.log("Refusing: .arc-research-key already exists.");
    process.exit(1);
  }
  const key = generatePrivateKey();
  writeFileSync(keyFile, key + "\n", { mode: 0o600 });
  const gi = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
  if (!gi.split("\n").includes(keyFile)) appendFileSync(".gitignore", "\n" + keyFile + "\n");
  console.log("Research wallet address:", privateKeyToAccount(key).address);
  console.log(
    "Fund it with at most $1 of USDC on Arc mainnet (chain 5042). Then set ARC_RESEARCH_PRIVATE_KEY on the server.",
  );
  process.exit(0);
}

if (!process.env["ARC_RESEARCH_PRIVATE_KEY"] && existsSync(keyFile))
  process.env["ARC_RESEARCH_PRIVATE_KEY"] = readFileSync(keyFile, "utf8").trim();

const { researchConfig, formatUsdcAtomic, ARC_USDC } =
  await import("../src/server/v2p/arc-research/config");
const { parsePaymentRequired, selectRequirement } =
  await import("../src/server/v2p/arc-research/x402");
const { researchService } = await import("../src/server/v2p/arc-research/service");
const { memoryIO, researchStore } = await import("../src/server/v2p/arc-research/store");
const { researchAccount } = await import("../src/server/v2p/arc-research/wallet");
const { listActiveEvents } = await import("../src/server/v2p/gemini");

const cfg = researchConfig();
const acct = researchAccount();
const rpc = cfg.rpcUrl(cfg.networks[0] ?? "eip155:5042");

// 1. Unpaid probe
const probe = await fetch(cfg.url + "?q=bitcoin");
const pr = parsePaymentRequired(probe.headers, await probe.text());
const v = pr ? selectRequirement(pr, cfg) : { ok: false as const, reason: "no PAYMENT-REQUIRED" };
console.log(
  "402 probe:",
  probe.status,
  v.ok
    ? `${v.requirement.network} ${formatUsdcAtomic(v.requirement.amount)} payTo ${v.requirement.payTo}`
    : "REFUSED " + v.reason,
);
if (!v.ok) process.exit(1);

// 2. Wallet balance (read only)
if (acct && rpc) {
  const data = "0x70a08231" + acct.address.slice(2).toLowerCase().padStart(64, "0");
  const r = (await (
    await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: ARC_USDC, data }, "latest"],
      }),
    })
  ).json()) as { result?: string };
  console.log(
    "Research wallet:",
    acct.address,
    "USDC:",
    r.result ? formatUsdcAtomic(BigInt(r.result)) : "unknown",
  );
} else console.log("Research wallet: not configured");

// 3. Gemini market to compare
const { events } = await listActiveEvents();
const ticker =
  args.find((a) => /^[A-Z0-9]+$/.test(a)) ??
  events.find((e) => /^BTC\d{10}$/.test(e.ticker ?? ""))?.ticker;
console.log("Gemini event:", ticker ?? "none found");
if (!pay || !ticker) {
  console.log("Dry run complete. Nothing was signed.");
  process.exit(0);
}

// 4. One real payment, only with explicit confirmation
if (process.env["ARC_CONFIRM_SPEND"] !== "YES" || !cfg.paymentsEnabled || !acct) {
  console.log(
    "Refusing to pay: set ARC_RESEARCH_PAYMENTS=true, ARC_CONFIRM_SPEND=YES and a funded key.",
  );
  process.exit(1);
}
const sid = crypto.randomUUID();
const svc = researchService({ store: researchStore(memoryIO()), cfg, account: researchAccount });
const q = await svc.quote({ sid, eventTicker: ticker });
console.log("Quote:", q.price_usd, q.network, "for", q.gemini.title, q.gemini.contractLabel);
const started = Date.now();
let r = await svc.approve({ sid, quoteId: q.quote_id, maxAtomic: "10000" });
console.log("Paid call:", r.status, `${Date.now() - started} ms`, "tx", r.tx_hash ?? "none");
for (let i = 0; i < 10 && r.status === "paid"; i++) {
  await new Promise((s) => setTimeout(s, 2000));
  r = await svc.status({ sid, quoteId: q.quote_id });
}
console.log("Final:", r.status, r.explorer_url ?? "", r.error ?? "");
if (r.comparison) {
  console.log("Markets returned:", r.comparison.markets_found);
  for (const row of r.comparison.rows)
    console.log(
      " -",
      row.market.venue,
      row.match,
      row.market.title,
      row.market.yesAsk,
      "|",
      row.differences.join(" "),
    );
  console.log("Summary:", r.comparison.summary);
}

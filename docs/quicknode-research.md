# Konviction crypto research (QuickNode x402 on Arc Testnet)

When a user selects **any** cryptocurrency prediction in Gemini Sandbox, Konviction automatically
identifies that exact market and its underlying coin, shows verified market context for free, and,
for ETH, BTC, SOL and XRP, offers real mainnet **DEX buy vs sell volume** fetched through QuickNode
x402 and paid in testnet USDC on Arc Testnet via Circle Gateway nanopayments (one nanopayment per
data call, with the number of calls and the maximum price stated before approval). The voice agent offers the exact price and waits for explicit spoken approval. Trading is untouched: YES/NO orders keep their own proposal and confirmation.

## Flow

1. **Select** a contract. `src/voice.ts` `setVisibleContract` calls `ResearchClient.select()`, which
   always calls `POST /api/public/quicknode-research/context`: public, free, no session token,
   nothing stored. Selecting a market never creates a quote or ledger entry.
   - The unpaid, session-bound `POST …/quote` runs only on request: the agent's read-only
     `request_research_quote` tool, or the card's **Get paid … research price** button (shown only
     with a voice session and a paid route).
2. **Identify** (`asset.ts`) from Gemini metadata only:
   - The contract must be listed in the event, carry the event's ticker (`GEMI-<event>-…`) and settle
     on the same index as the event. Otherwise `CONTRACT_MISMATCH`.
   - Category must be Crypto. Otherwise `NOT_CRYPTO`, and the UI shows no card.
   - Symbol votes come from the contract rules text ("price of Solana (SOL)"), the title, the event
     ticker (`SOL05M…`) and the series (`SOL1H`). At least two must name it and none may differ.
     Otherwise `ASSET_UNRESOLVED` or `ASSET_CONFLICT`. The name comes from the rules text or subcategory.
3. **Context** (`context.ts`, free): contract label, strike, expiry, settlement index, YES/NO buy and
   sell prices, market-implied YES %, spread. From Gemini's public settlement-index klines (the series
   the contract resolves against): last value, 60-minute change, 60-minute realized volatility of
   1-minute log returns, high/low and the strike's distance from the index. If index history is
   missing the card says so. No third-party price feed and no invented spot values.
4. **Route** (`routes.ts`). Paid research is offered only if all three hold:
   - the asset's symbol **and** name match ETH, BTC, SOL or XRP (so a "SOL" named "Solar Token"
     never gets Solana data);
   - Konviction has verified pools and a fixed, allowlisted read-only plan for it (`dex/`);
   - QuickNode's free `GET https://x402.quicknode.com/networks` lists that network right now.

   QuickNode returns 402 for *any* path, so a 402 alone proves nothing. If any check fails, the
   result is `context_only` with an explicit limitation, and nothing is charged.
5. **Quote** with a timeframe: 5m, 15m, 1h or 24h. It defaults to the prediction's own duration
   (series `…05M` → 5m, `…15M` → 15m, `…1H` → 1h, anything longer → 24h); the voice agent passes
   another timeframe only when the caller asks. The unpaid 402 gives the per-call price; the quote
   stores `calls_planned` (an exact upper bound) and `price_atomic = per-call × calls_planned`, and the
   spoken offer states both. A plan above the 0.01 USDC per-request cap is not offered.
6. **Approve** (authenticated ElevenLabs voice webhook) and **pay**: durable Blob reservation of the
   maximum, caps, idempotency, pre-signing checks. The SDK may create at most `calls_planned`
   payments, each identical to (or cheaper than) the quoted per-call terms; every request body must
   pass the market's allowlist. When the session ends, the ledger holds `per-call × payments created`
   (unused budget is released). Signed-but-no-data stays `unknown_pending` holding the full amount
   and is never resent.

## What is measured (verified 2026-11-20 against real mainnet data)

Only four numbers, from the asset's perspective: **USD bought, USD sold, net buy volume, buy % of
volume**. Plus: measured window (exact start/end), complete/partial/unavailable, pools, source,
trade count, last trade time and example transaction links. Stablecoins count at $1.

| Asset | QuickNode network | Source (fixed) | Paid calls (5m / 15m / 1h / 24h) |
|---|---|---|---|
| ETH | `ethereum-mainnet` | Uniswap V3 `Swap` logs: WETH/USDC 0.05% `0x88e6…5640`, 0.3% `0x8ad5…e6d8`; WETH/USDT 0.05% `0x11b8…97f6`, 0.3% `0x4e68…fa36` | 3 / 3 / 4 / 27 |
| BTC | `ethereum-mainnet` | Uniswap V3 `Swap` logs: WBTC/USDC 0.3% `0x99ac…bc35`, 0.05% `0x9a77…7d16`; WBTC/USDT 0.3% `0x9db9…425b` (**wrapped-BTC proxy**) | 3 / 3 / 3 / 7 |
| SOL | `solana-mainnet` | Orca Whirlpool SOL/USDT `FwewVm8u6tFPGewAyHmWAqad9hmF7mvqxK4mJ7iNqqGC`: vault balance deltas from `getTransaction` | ≤76 / ≤76 / ≤77 / ≤78 |
| XRP | `xrp-mainnet` | XRP/RLUSD AMM `rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3` (RLUSD issuer `rMxCK…m5De`, domain ripple.com): validated `account_tx` metadata | ≤1 / ≤1 / ≤2 / ≤10 |

At 0.0001 USDC per call: ETH 0.0003–0.0027, BTC 0.0003–0.0007, SOL ≤0.0076–0.0078, XRP ≤0.0001–0.001.

Pools were verified read-only: Uniswap pools via `factory()` (= Uniswap V3 factory),
`token0/token1/fee`; the Whirlpool via its account data (program owner, mints, vaults); the AMM via
`amm_info` and `account_info.AMMID`.

Decoding rules:
* **Uniswap V3**: `amount0/amount1` are the pool's signed balance changes (int256, two's
  complement). The trader receives what the pool sends. WETH 18, WBTC 8, USDC/USDT 6 decimals. Logs
  must be from a listed pool, carry the `Swap` topic, be two-sided and not `removed`.
* **Router hops**: legs are netted per transaction across all monitored pools, so a USDT→WETH→USDC
  route or a round trip counts once by its net effect (exact pass-throughs are dropped and reported).
* **Solana**: a swap is a transaction whose SOL vault and USDT vault move in opposite directions
  (matched by vault address, including lookup-table addresses, and mint). Same-direction moves
  (liquidity adds/removes), one-sided moves (fees) and failed transactions are ignored.
* **XRPL**: a swap moves the AMM account's XRP balance and its RLUSD trust line in opposite
  directions in a validated, `tesSUCCESS` transaction. Deposits/withdrawals and open offers never
  count. Order-book fills that bypass the AMM are not covered.
* **Time**: Ethereum uses block timestamps (the window starts at a fetched header ≥ the full window
  old); Solana uses `blockTime`; XRPL uses the ledger close `date` (Ripple epoch).

Completeness: a report is **complete** only if every planned call succeeded and the measured span
covers the requested window. Anything less is **partial** with the actual measured span, or
**unavailable** with null totals. Totals are never extrapolated.

Known coverage limits: SOL decodes at most 75 transactions per request, so windows longer than
roughly 5 minutes on that pool are usually partial (the deep SOL/USDC pools run 500+ transactions per
5 minutes, which a 0.01 USDC per-request cap cannot cover). XRP covers the AMM only. ETH/BTC cover the
listed Uniswap v3 pools only.

Reproduce with free public RPCs (no QuickNode, no payment):
`npx tsx scripts/dex-research-verify.ts --asset=eth --timeframe=1h`.

Example verified transactions (2026-11-20): ETH buy $383,675.96
`0x1ede0a273c4ed2037e3e0390d76d36d186b9cae687716e8855aeaa30ba48be9b` and sell $148,751.53
`0x79c35caa0d12d5da04811f06d7d9b2c7fe7ce3be2d3629989bff6dadd7f861b1` (both matched against ERC-20
Transfer events); XRP buy $861.54 `EAA11B52CF1C6C819F5E9B1E4141DBEDB26A83FFC64C9F280ADA210779DCA349`
(an OfferCreate whose TakerPays is XRP).

## Safety model (unchanged)

* Server-only modules under `src/server/v2p/quicknode-research/`, behind the dynamically imported route
  `src/routes/api/public/quicknode-research/$action.ts`. `RESEARCH_WALLET_PRIVATE_KEY` is read only in
  `wallet.ts` (a test enforces this). The SDK is not in the browser bundle.
* `quote`, `approve`, `status` need the server-signed voice-session bearer. Quotes are bound to `sid`,
  the exact Gemini contract, the route and its URL, with a 4-minute TTL.
* The agent has two read-only tools (`request_research_quote`, `get_research_result`). The voice webhook verifies the signed session, call ID, exact offer and immediate caller assent with the shared Gemini confirmation verifier. It uses the stored quote amount and quote ID for idempotency.
* Validation: resource URL equals the route URL; Arc Testnet; `exact` + `GatewayWalletBatched`; Arc
  USDC; allowlisted payee and Gateway verifier; per-call price within the cap, and per-call × planned
  calls within the per-request cap. At payment time the SDK is capped at the quoted per-call amount,
  refuses any differing requirement, and refuses to create more than the planned number of payments.
* Allowlist (`dex/*.ts`): only `eth_getBlockByNumber` (no full transactions) and `eth_getLogs` for
  the exact pool set + `Swap` topic within the chunk size; `getSignaturesForAddress` for the fixed
  pool and `getTransaction`; `account_tx` for the fixed AMM account. Nothing else can be sent.
* Durable, atomic budget in private Vercel Blob (`quicknode-research/v2/ledger.json`). Caps:
  0.01 per request, 0.10 per session, 0.25 per UTC day, across all assets. Env may only lower them.
  No Blob means approval fails closed.
* Research modules never import trading code. Tests check the source and that approval never calls
  Gemini execution.

## Evidence and what it means

HTTP status, API time, request id, JSON-RPC error, response SHA-256, whether a payment was signed,
`payment-response` presence and decoded fields (`transaction` shown as a provider reference; JWT
dropped), and the Gateway available balance before and after. These are kept distinct:
1. **Gateway deposit:** the earlier on-chain deposit.
2. **Gateway deduction:** the observed balance change around this request.
3. **Paid API response:** the data returned after signing.
4. **On-chain batch settlement:** done later by Circle. No per-request settlement transaction is claimed.

## Vercel setup (Alex, dashboard only)

Never paste keys into chat, GitHub, PRs, logs or repo files.
1. Settings → Environment Variables:
   * `RESEARCH_WALLET_PRIVATE_KEY` (Sensitive; entered by the owner).
   * `QUICKNODE_RESEARCH_WALLET_ADDRESS=0xCCde7269456582b7Bd445C2AB673E109C038F2D4`.
   * `QUICKNODE_RESEARCH_PAYMENTS=true` only for the demo.
2. Blob storage: the existing private store's `BLOB_READ_WRITE_TOKEN` works. Research uses its own path.
3. `VOICE_SESSION_SECRET` must already be set.
4. Redeploy and check `GET /api/public/quicknode-research/config`.

## ElevenLabs setup

Add client tools `request_research_quote` and `get_research_result` from
`agent/browser-client-tools.json`. Append the "Crypto research" section of `agent/system_prompt.md`.
Register the server webhook in `agent/confirm-research-purchase.json` with the same provider-only secret as Gemini call confirmation. Publish.

## Demo

1. Select a BTC (or ETH, SOL, XRP) contract. The card identifies the coin and shows context.
2. Select a market during the call or ask for more data. The offer names the asset, the window, the
   number of paid calls and the maximum fee. Ask for "the last 24 hours" to get a new offer.
3. Say **yes** after the exact offer. The card shows bought / sold / net / buy %, the measured window,
   pools and example transactions plus payment evidence; the agent reads it with the caveat.
4. Select a HYPE or ZEC contract: context only, with the limitation and no charge.
5. Separately: "Buy two dollars of YES" uses the existing proposal and spoken confirmation.

## Smoke script (read-only by default)

```sh
npx tsx scripts/quicknode-research-smoke.ts                 # every route: listed + unpaid quote valid + cost per timeframe
RESEARCH_WALLET_PRIVATE_KEY=… npx tsx scripts/quicknode-research-smoke.ts --route=eth --balance
QUICKNODE_SMOKE_ALLOW_PAYMENT=I_ACCEPT_TESTNET_SPEND RESEARCH_WALLET_PRIVATE_KEY=… \
  npx tsx scripts/quicknode-research-smoke.ts --route=eth --timeframe=5m --pay   # ONE research request (≤3 calls)
```

## Not covered

QuickNode x402 RPC only. No QuickNode Stream is configured, so this does not qualify for a Streams bounty.

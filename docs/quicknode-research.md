# Konviction crypto research (QuickNode x402 on Arc Testnet)

When a user selects **any** cryptocurrency prediction in Gemini Sandbox, Konviction automatically
identifies that exact market and its underlying coin, shows verified market context for free, and,
when a supported paid source exists for that coin, offers one QuickNode x402 network-activity
request paid in testnet USDC on Arc Testnet via Circle Gateway nanopayments. The voice agent offers the exact price and waits for explicit spoken approval. Trading is untouched: YES/NO orders keep their own proposal and confirmation.

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
   - the asset's symbol **and** name match a chain whose native asset it is (so a "SOL" named
     "Solar Token" never gets Solana data);
   - Konviction has a fixed read-only method for that chain family;
   - QuickNode's free `GET https://x402.quicknode.com/networks` lists that network right now.

   This list check is required because QuickNode returns 402 for *any* path, including networks it
   does not serve, so a 402 proves nothing. If any check fails, the result is `context_only` with an
   explicit limitation, and nothing is charged.
5. **Approve** (authenticated ElevenLabs voice webhook) and **pay** exactly as before: durable Blob reservation, caps,
   idempotency, pre-signing checks, `unknown_pending` never resent.

## Routes (verified listed and quoting 0.0001 USDC on Arc Testnet, 2026-11-20)

| Asset (symbol + name) | QuickNode network | Method (fixed) | Report |
|---|---|---|---|
| BTC/XBT · Bitcoin | `btc-mainnet` | `getmempoolinfo` | pending tx, mempool MB, min fee (snapshot) |
| ETH · Ether/Ethereum | `ethereum-mainnet` | `eth_feeHistory(120)` | gas utilization recent vs previous 60 blocks, base fee |
| SOL · Solana | `solana-mainnet` | `getRecentPerformanceSamples(120)` | period-weighted non-vote TPS, recent vs previous |
| XRP · XRP/Ripple | `xrp-mainnet` | `fee` | open-ledger size vs expected, queue, fees (snapshot) |
| HYPE · Hyperliquid | `hype-mainnet` | `eth_feeHistory(120)` | HyperEVM utilization (not HyperCore) |
| LTC, DOGE, BCH | `ltc-`, `doge-`, `bch-mainnet` | `getmempoolinfo` | snapshot |
| BNB, POL/MATIC | `bsc-`, `matic-mainnet` | `eth_feeHistory(120)` | utilization |

Gemini Sandbox currently lists BTC, ETH, SOL, XRP, HYPE and ZEC. **ZEC** has no QuickNode network,
so it gets context only. An unknown coin is identified from metadata and gets context only. Adding a
chain means one `ROUTES` entry with a verified method; no other code changes.

## Safety model (unchanged)

* Server-only modules under `src/server/v2p/quicknode-research/`, behind the dynamically imported route
  `src/routes/api/public/quicknode-research/$action.ts`. `RESEARCH_WALLET_PRIVATE_KEY` is read only in
  `wallet.ts` (a test enforces this). The SDK is not in the browser bundle.
* `quote`, `approve`, `status` need the server-signed voice-session bearer. Quotes are bound to `sid`,
  the exact Gemini contract, the route and its URL, with a 4-minute TTL.
* The agent has two read-only tools (`request_research_quote`, `get_research_result`). The voice webhook verifies the signed session, call ID, exact offer and immediate caller assent with the shared Gemini confirmation verifier. It uses the stored quote amount and quote ID for idempotency.
* Validation: resource URL equals the route URL; Arc Testnet; `exact` + `GatewayWalletBatched`; Arc
  USDC; allowlisted payee and Gateway verifier; price within the cap. At payment time the SDK is
  capped at the quoted amount and refuses any differing requirement before signing.
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

1. Select a BTC (or ETH, SOL, XRP, HYPE) contract. The card identifies the coin and shows context.
2. Select a market during the call or ask for more data. The first offer names QuickNode, the coin and the exact fee.
3. Say **yes** after the exact offer. The card shows the network report and
   payment evidence, and the agent reads it with the caveat.
4. Select a ZEC contract: context only, with the limitation and no charge.
5. Separately: "Buy two dollars of YES" uses the existing proposal and spoken confirmation.

## Smoke script (read-only by default)

```sh
npx tsx scripts/quicknode-research-smoke.ts                 # every route: listed + unpaid quote valid
RESEARCH_WALLET_PRIVATE_KEY=… npx tsx scripts/quicknode-research-smoke.ts --route=btc --balance
QUICKNODE_SMOKE_ALLOW_PAYMENT=I_ACCEPT_TESTNET_SPEND RESEARCH_WALLET_PRIVATE_KEY=… \
  npx tsx scripts/quicknode-research-smoke.ts --route=btc --pay   # ONE paid request
```

## Not covered

QuickNode x402 RPC only. No QuickNode Stream is configured, so this does not qualify for a Streams bounty.

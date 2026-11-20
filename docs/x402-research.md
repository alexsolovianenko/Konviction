# Arc x402 research (handoff)

Optional "second opinion" for a Gemini prediction market. The voice agent can quote the price of an independent cross-venue comparison (Kalshi, Polymarket and others via BlockRun's market search). The user approves that price on screen, the server pays it in USDC on Arc using x402 v2 with an EIP-3009 authorization, and the result is compared with the Gemini contract. It never places, changes or approves a Gemini order.

## Flow

1. `request_research_quote` (voice client tool) → `POST /api/public/arc-research/quote`. The server makes one **unpaid** request, reads the HTTP 402 `PAYMENT-REQUIRED` header, validates it and stores a quote. Nothing is signed.
2. The research card shows the price. Only the on-screen **Approve** button calls `POST /api/public/arc-research/approve` with the voice session bearer. No voice tool can approve or pay.
3. The server reserves the purchase atomically (owner, expiry, daily cap, fresh nonce), signs one EIP-3009 authorization, and sends the paid request once. A failure after signing is recorded as `unknown_after_sign` and is never re-signed.
4. `get_research_result` (voice) / `POST .../status` reads progress. A purchase becomes `settled_onchain` only after the Arc receipt shows the exact USDC transfer from the research wallet to the allowlisted recipient.
5. The comparison labels every difference (settlement index, strike, expiry, contract type), drops markets that already closed, and is spoken as "what other traders pay", never as a forecast or Gemini's fair price.

## Safety rules enforced in code

- Payments are off unless `ARC_RESEARCH_PAYMENTS` is exactly `true` and a wallet key is set.
- Provider host allowlist: HTTPS on `arc.blockrun.ai` only, no port or credentials, whatever `ARC_RESEARCH_URL` says.
- Allowlisted network, asset (Arc USDC `0x3600000000000000000000000000000000000000`), recipient and scheme (`exact`, EIP-3009). Re-checked at approval.
- Hard caps: $0.01 per call and $0.25 per UTC day. Env can only lower them.
- The private key is read only in `wallet.ts`, is never returned or logged, and is not in the browser bundle (route handlers import the server code dynamically).
- `arc-research` code imports only Gemini public reads, session verification and `util`. A test fails if it imports the trade engine, ledgers or order paths.

## Files

| Path | Role |
| --- | --- |
| `src/server/v2p/arc-research/x402.ts` | Parse 402 / settlement headers; validate requirements |
| `src/server/v2p/arc-research/eip3009.ts` | Build and sign the TransferWithAuthorization |
| `src/server/v2p/arc-research/verify.ts` | Arc RPC receipt and authorization-used checks |
| `src/server/v2p/arc-research/store.ts` | Purchase records: Vercel Blob with conditional writes, or in-memory |
| `src/server/v2p/arc-research/service.ts` | Quote → approve → status flow |
| `src/server/v2p/arc-research/compare.ts` | Normalize provider data and compare with the Gemini contract |
| `src/server/v2p/arc-research/config.ts` | Allowlists, caps, RPC and explorer defaults |
| `src/server/v2p/arc-research/wallet.ts` | The only place the key is read |
| `src/server/v2p/arc-research/handler.ts` | HTTP surface, signed-session auth |
| `src/routes/api/public/arc-research/$action.ts` | Route (dynamic import) |
| `src/research.ts`, `src/components/prediction/ResearchCard.tsx` | Browser client, voice tools and the research card |
| `agent/arc-research-prompt.md` | Text to append to the agent system prompt |
| `scripts/arc-research-smoke.ts` | Standalone check; free unpaid probe by default |

Shared files touched minimally: `package.json` / `package-lock.json` (adds `viem` only), `.gitignore` (`.arc-research-key`), `src/voice.ts` (registers the two research tools and the approve call), `src/components/prediction/PredictionPanel.tsx` (renders the card), `agent/browser-client-tools.json` (two tool schemas), `src/routeTree.gen.ts` (generated route entry).

## Integration requirements

- **Voice session:** the endpoints accept only the server-signed voice session bearer from `browser-session.ts` (`VOICE_SESSION_SECRET`), the same token browser trading uses.
- **Durable store before enabling payments:** set `BLOB_READ_WRITE_TOKEN` (or link a Blob store, `BLOB_STORE_ID`). Without it the handler falls back to an **in-memory store**, which is fine for local tests but on serverless hosting is per instance: the daily cap and duplicate-payment protection would not be shared. Do not set `ARC_RESEARCH_PAYMENTS=true` on a deployment without Blob. There is no Supabase-backed research store.
- **ElevenLabs agent:** add `request_research_quote` and `get_research_result` from `agent/browser-client-tools.json` as client tools and append `agent/arc-research-prompt.md` to the system prompt.
- **Gemini data:** uses `getEvent` from `src/server/v2p/gemini.ts` (public sandbox reads). Crypto price markets only (BTC, ETH, SOL, XRP, DOGE).

## Settings (names only)

`ARC_RESEARCH_PAYMENTS`, `ARC_RESEARCH_PRIVATE_KEY`, `ARC_NETWORKS` (default `eip155:5042`), `ARC_RPC_URL` / `ARC_TESTNET_RPC_URL`, `ARC_RESEARCH_PAYTO`, `ARC_RESEARCH_URL`, `ARC_MAX_PER_CALL_ATOMIC`, `ARC_MAX_PER_DAY_ATOMIC`, plus `BLOB_READ_WRITE_TOKEN` and `VOICE_SESSION_SECRET`.

## Verification status

- **Live, unpaid (2026-11-19):** BlockRun's 402 offers Arc mainnet `eip155:5042`, 8500 atomic USDC ($0.0085), asset `0x3600…0000`, payTo `0x634D274e67DafaF76C54153aa113906a606e1E0B`, x402 v2, EIP-3009.
- **Tests:** `npx vitest run src/server/v2p/arc-research src/components/prediction/ResearchCard.test.tsx` (simulated provider and RPC; recorded 402 fixtures).
- **Not yet done:** no real paid request and no onchain settlement. BlockRun offers mainnet only; the "Best Use of Arc" award text asks for Arc Testnet.

## Checks

```sh
npx tsx scripts/arc-research-smoke.ts   # free: unpaid 402 probe + Gemini market lookup; never pays without --pay
```

Do not run `--new-wallet` or `--pay` without the owner's approval; `--pay` spends real USDC on Arc mainnet.

# Setup and operations

[Project overview and walkthrough](../README.md)

## Run locally

**Requirements:** Node.js **24.10+**, npm.

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**.

The launcher starts a private loopback capture service on an ephemeral port and forwards its API paths through the same origin. Server settings load in this order:

1. Process environment
2. Local `.env`
3. `../UBC-Hackathon/.env` for missing values

Set `SERVER_ENV_FILE` to choose a different fallback file. **Never expose secrets through `VITE_`-prefixed environment variables.**

```bash
npm test
npm run build
npm run preview -- --port 5173
```

For Cloudflare Workers:

```bash
npm run build:worker
```

A standalone Worker needs an external persistent Node/SQLite capture service and same-origin routing for `/api/voice`, `/api/transcripts`, `/api/intents`, and `/api/tools`.

## 🔑 Configuration

Use `.env.example` as the reference. **Keep all private credentials server-side.**

| Variable | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | Signed browser voice sessions / provider access |
| `ELEVENLABS_AGENT_ID` | Active ElevenLabs agent |
| `ELEVENLABS_BRANCH_ID` | Follow a branch's latest published version in hosted voice |
| `GEMINI_API_KEY` / `GEMINI_API_SECRET` | Gemini Sandbox authenticated account and trade operations |
| `EXECUTION_ENABLED` | Explicit execution switch; defaults off |
| `SQLITE_PATH` | Persistent writable local proposal/order storage |
| `VOICE_SESSION_SECRET` | Hosted voice session protection |
| `ELEVENLABS_CALL_CONFIRM_SECRET` | Shared secret for the hosted ElevenLabs confirmation tool |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Optional existing Supabase ledger and activity data |
| `TOOL_SHARED_SECRET` | Authenticates private phone tool calls |

### ElevenLabs setup

Register the browser tools from `agent/browser-client-tools.json`, plus `capture_order_intent`, `capture_cancel_intent`, and `get_order_status`. Enable `skip_turn` and `end_call` as system tools.

Recommended agent settings:

- First message: **“Would you like to place an order?”**
- Both silence waits: **7 seconds**
- `skip_turn.wait_timeout_secs`: **-1**

For hosted trade confirmation, register `agent/confirm-hosted-sandbox-buy.json` as a **server tool** on the active agent. Supply the ID of an ElevenLabs workspace secret matching `ELEVENLABS_CALL_CONFIRM_SECRET` on Vercel.

## 📈 Market data and tools

Public market browsing needs **no key, wallet, account, or database**.

Search pages through active Gemini Sandbox events in batches of **100** by event title, ticker, category, contract label, and symbol. Results include up to **8 matching events**, with up to **8 contracts per event**. Empty searches show the first results.

Quote selection refetches the event. Gemini prices are denominated in dollars per YES/NO contract; the UI converts them to cents. Missing quotes and upstream failures are shown explicitly.

The browser and voice both use fresh public GET requests via `/api/public/market-tools`:

```js
search_markets({ query })
get_orderbook({
  event_ticker,
  contract_symbol,
  outcome?,
  side?,
  quantity?,
  limit_price?
})
```

The console overview uses `/api/public/dashboard-state` and caches the public event listing for **15 seconds**.

## 🛡️ Trade confirmations and safety

Trade preparation uses `prepare_sandbox_buy` for both buys and held-position exits. Specify exact `event_ticker` and `contract_symbol` strings returned from market search.

- **Buy:** `outcome` is `yes` or `no`, and `quantity` is a positive integer.
- **Sell:** Set `side: "sell"` with a quantity, or `close_all: true`.
- **Market-style order:** Set `order_mode: "market"`.
- **Limit order:** Supply an eligible `limit_price` in one-cent increments.

The proposal surfaces the contract, fresh quote, limit, quantity, estimated fee, readback, expiration, and readiness. After reviewing it, say **“Buy now”** for an immediate buy or confirm the exact limit terms in the **same voice session**. The backend validates the spoken confirmation, session, expiry, price, and single-use proposal claim.

The buyer's dollar budget includes estimated fees. Submitting an immediate buy happens once at the approved maximum price; Gemini may fill partially and cancels any remainder.

### Local API

All local operations return JSON with `Cache-Control: no-store`.

| Endpoint | Inputs / authentication | Result |
|---|---|---|
| `GET /api/trading/availability` | Local origin | Execution readiness and missing configuration |
| `POST /api/trading/proposals` | Active voice-session bearer, UUIDv4 `Idempotency-Key`, market identifiers, outcome and order terms | Fresh proposal, `proposal_id`, `expires_at`, readiness |
| `POST /api/trading/voice-confirm` | Active-session bearer, proposal ID, confirmation transcript sequence | Verified speech confirmation and sandbox result |
| `POST /api/trading/portfolio` | Empty JSON body | Allowlisted active orders, positions and order history, with per-feed errors |

Open **Account** at `/dashboard` for positions and orders. `/open-trades` redirects there. Account reads expose the shared sandbox account without a PIN; they do not authorize execution. Only same-origin loopback clients can access local browser trading.

Local proposal and result records use SQLite at `SQLITE_PATH`. The local launcher disables the separate Supabase execution path. Use **one trading authority per sandbox account** and share SQLite across local processes.

## Phone and private agent tools

For the dedicated ElevenLabs telephone branch, inbound Twilio routing, sandbox demo account and consent-based outbound notifications, follow the [telephone setup guide](phone-calls.md). The shared-secret configuration below applies to the legacy private tools.

The private phone integration uses `x-tool-secret` with `TOOL_SHARED_SECRET`, plus trusted caller and conversation variables configured on the provider side. Keep Gemini signing credentials, the Supabase service-role key, shared secret, and PIN on the server.

Phone execution requires all relevant checks, including `EXECUTION_ENABLED=true`, an explicitly enabled database execution flag, valid PIN, credentials, and server-side proposal validation. **Execution is off by default.**

Phone order execution and the local browser path use separate authorities and must not be assumed interchangeable. A real inbound test is required to verify number routing, greeting, transcription, model/tool response, confirmations, and exchange execution.

## ☁️ Deploy to Vercel

Use Node.js **24** and npm.

```bash
npm run build:vercel
```

This builds the UI and Node function in `.vercel/output`. Vercel serves UI and public API on the same origin. Local development uses SQLite; hosted trading requires configured Supabase ledger or a linked private Vercel Blob store.

For hosted trades, configure:

```text
VOICE_SESSION_SECRET
GEMINI_API_KEY
GEMINI_API_SECRET
EXECUTION_ENABLED=true
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
ELEVENLABS_BRANCH_ID
ELEVENLABS_CALL_CONFIRM_SECRET
```

Also configure **private persistent order storage** and the ElevenLabs server confirmation tool. Set `ELEVENLABS_BRANCH_ID` from the agent URL's `branchId` so the hosted app uses that branch's latest published version. Redeploy after changing environment variables.

**Important:** Anyone with access to the hosted voice app can confirm test-funds trades in the shared Gemini Sandbox account if execution is enabled. Use a single ledger per sandbox account to keep proposals, fills and history consistent.

The hosted Account screen and voice position tool read the same sandbox account. Public market browsing continues to work without private integrations. Standalone Workers do not expose the local trading endpoints, and their public dashboards omit private account data.

### Voice troubleshooting

```bash
npm run voice:doctor -- <conversation-id>
```

Omit the conversation ID to inspect the latest call. This reads ElevenLabs metadata without initiating calls or submitting orders.

If the provider returns only `3000`, optionally test synthesis:

```bash
npm run voice:doctor -- <conversation-id> --probe-audio
```

This sends a short “Hi.” to the synthesis API and **may consume credits**.

## Private integrations and legacy notes

For optional crypto research, see the [QuickNode x402 guide](quicknode-research.md). It covers free Gemini context, supported assets, per-call quotes and separate approval for payment in Arc testnet USDC.

- Captures use session-scoped bearer tokens, local SQLite, and recorded confirmation evidence. Legacy capture tools record intents only, not exchange orders.
- Gemini Sandbox API credentials with the right roles are required for private account data. Only the Sandbox origin is accepted.
- Activity, trades, and receipts backed by Supabase require the existing schema, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
- Optional Solana **devnet** receipt anchoring requires a funded signing wallet. The public dashboard does not retry anchoring.
- Historical simulated API examples and fixtures belong to the earlier capture prototype. Former simulated market routes now return **HTTP 410**.
- If using the alternative Supabase backend with the older integer-quantity schema, apply [`scripts/supabase-fractional-position-quantities.sql`](../scripts/supabase-fractional-position-quantities.sql) to support fractional position exits. Vercel Blob and SQLite already store decimal quantities.
- Telephony, private credentials, paid voice, external paid research, and actual exchange execution must each be verified in the target environment.

# Voice-to-Predict

The home page combines the TanStack console, Gemini Sandbox event search and contract quotes, and ElevenLabs browser voice with a live transcript and session-scoped captured intents.

## Local setup

Use Node 24.10 or newer with npm. From this directory:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The launcher starts a private loopback capture service on an ephemeral port and forwards its API paths through the same origin. It loads server settings from the environment, then the local .env, then ../UBC-Hackathon/.env for missing values. Set SERVER_ENV_FILE to choose another fallback file. Keep secrets out of VITE-prefixed variables. To test and build, run `npm test` and `npm run build`. Use `npm run preview -- --port 5173` to serve the built app with the capture service. For the Cloudflare worker target, run `npm run build:worker`. A standalone worker deployment needs a separate persistent Node/SQLite capture service and same-origin routing for /api/voice, /api/transcripts, /api/intents and /api/tools.

## Public market data

No keys, wallet, account or database are necessary for market reads. Search markets queries the current listing of up to 100 active Gemini Sandbox events. An empty search returns the first results. Matching uses event titles, tickers, category, contract labels and symbols. Results include up to eight matching events and eight contracts per event. Select a quote to fetch the event again. Prices come from Gemini in dollars per YES or NO contract and the UI shows cents. Missing quotes and upstream failures are displayed explicitly.

The browser and voice use the same handlers and results. The client tools are `search_markets({query})` and `get_orderbook({event_ticker, contract_symbol})`. Both use fresh public GETs via /api/public/market-tools. The console's separate overview polls /api/public/dashboard-state and caches the public event listing for 15 seconds.

## Optional private features

- Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID for signed browser voice sessions. Register the two market tools and the existing capture_order_intent, capture_cancel_intent and get_order_status as browser client tools. Starting voice uses the microphone and the provider account.
- Captures use local SQLite, a bearer token scoped to the browser session and recorded confirmation evidence. A new order intent requires a recognized open Gemini prediction contract. Status and cancellation refer to captured intents. Legacy capture tools only record intents. Separate local browser trading is documented below. Server files and SQLite storage must remain private.
- The account strip and positions require Gemini Sandbox API credentials with appropriate roles. Only the sandbox origin is accepted. Activity, trades and receipts require the existing Supabase schema, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. See .env.example. A missing private dependency leaves the public console usable.
- David's private phone tools require a server-supplied x-tool-secret header matching TOOL_SHARED_SECRET. Configure trusted caller and conversation variables on the provider side. Keep the secret, Gemini signing keys, Supabase service key and PIN on the server. Execution requires EXECUTION_ENABLED=true, an explicitly true database execution_enabled setting, the PIN, credentials and the server-side proposal checks. Execution defaults off. Receipt anchoring additionally uses Solana devnet and a funded signing wallet. The public dashboard does not retry anchoring.
- Historical simulated API examples and evaluation fixtures describe the earlier capture prototype. The former simulated market routes return HTTP 410 in the running app. Private account, telephony, paid voice and exchange execution require separate integration verification when credentials are available.

## Local browser sandbox trading

Start the local launcher with `npm run dev`, or run `npm run build` and `npm run preview -- --port 5173`. Browser proposals and PIN approvals use persistent SQLite at SQLITE_PATH. They reuse the phone backend's fresh quote, fee estimate, readback, re-quote and immediate-or-cancel execution code. Supabase, telephony and Solana are optional for the browser path. The local launcher gives browser execution exclusive use of its SQLite risk ledger and disables the separate Supabase phone execution path. Run one trading authority per sandbox account and share the SQLite file across local processes.

The client tool `prepare_sandbox_buy({event_ticker,contract_symbol,outcome,quantity,limit_price})` prepares a buy only. Both identifiers are exact strings from a market lookup. Outcome is yes or no, quantity a positive integer, and limit_price is a cent increment from 0.01 to 0.99 dollars per contract. The proposal appears on the current console or focused voice page with the actual contract, fresh quote, limit, quantity, estimated fee, readback and expiry. Approval requires a separate button and typed PIN while the same voice session is active. The model receives the proposal and approval availability. The PIN and approval outcome stay outside the voice tools.

Set DEMO_PIN in the **server** environment to a private four-digit value of your choice, set the Gemini sandbox API key/secret with the required trading role, and restart the launcher. EXECUTION_ENABLED must explicitly equal true for the browser approval button to operate. Keep it false to exercise preparation without submission. Use a persistent writable SQLITE_PATH. The service enforces quantity, per-order and UTC daily dollar caps, including estimated fees. It reserves the full approved amount for the day after even a partial fill and retains unresolved reservations across day boundaries. Reconcile uncertain outcomes with Gemini before taking further action. A single valid approval may submit one sandbox IOC; verification in this repository uses an in-memory SQLite database and a mocked exchange.

Local HTTP operations all return JSON with cache-control no-store:

| Operation | Authentication and inputs | Result |
| --- | --- | --- |
| GET /api/trading/availability | Local origin | Execution readiness and missing configuration |
| POST /api/trading/proposals | Active voice session bearer; UUIDv4 Idempotency-Key header; five prepare_sandbox_buy fields | Exact fresh proposal, proposal_id, expires_at and readiness |
| POST /api/trading/approve | Same active session bearer; JSON proposal_id and four-digit pin | Re-quoted result or explicit rejection; exact repeats replay the saved result |
| POST /api/trading/portfolio | Local account PIN in JSON pin field | Allowlisted account fields from sandbox active orders, positions and order history, with per-feed errors |

Open /open-trades from either voice page. It opens separately so the active conversation continues. The account PIN is entered on each refresh and cleared immediately. The local service locks PIN checks for 15 minutes after three consecutive incorrect attempts. Only same-origin loopback clients can use browser trading. The standalone public worker serves none of these local endpoints and its public dashboard omits private account data. Private phone integration still requires its own Supabase schema/service-role key, provider shared secret and database execution switch.

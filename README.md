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
- Captures use local SQLite, a bearer token scoped to the browser session and recorded confirmation evidence. A new order intent requires a recognized open Gemini prediction contract. Status and cancellation refer to captured intents. Browser voice never submits or cancels exchange orders. Server files and SQLite storage must remain private.
- The account strip and positions require Gemini Sandbox API credentials with appropriate roles. Only the sandbox origin is accepted. Activity, trades and receipts require the existing Supabase schema, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. See .env.example. A missing private dependency leaves the public console usable.
- David's private phone tools require a server-supplied x-tool-secret header matching TOOL_SHARED_SECRET. Configure trusted caller and conversation variables on the provider side. Keep the secret, Gemini signing keys, Supabase service key and PIN on the server. Execution requires EXECUTION_ENABLED=true, an explicitly true database execution_enabled setting, the PIN, credentials and the server-side proposal checks. Execution defaults off. Receipt anchoring additionally uses Solana devnet and a funded signing wallet. The public dashboard does not retry anchoring.
- Historical simulated API examples and evaluation fixtures describe the earlier capture prototype. The former simulated market routes return HTTP 410 in the running app. Private account, telephony, paid voice and exchange execution require separate integration verification when credentials are available.

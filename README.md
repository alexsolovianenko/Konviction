# Call-to-Predict · browser voice capture

Speak with a private ElevenLabs agent to prepare a Gemini spot or prediction limit order, prepare a cancellation, or query the simulated market catalog. The dashboard shows the timestamped conversation and the session’s captured intents. A capture records a request for later approval. All five tools run locally against SQLite or the frozen fixtures. No Gemini credentials, requests or execution are involved.

## Run locally

Use Node 26 and npm. From the repository root, run

```sh
npm ci
cp .env.example .env
```

Set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in this checkout’s server-side `.env`. Keep the default SQLite path or set `SQLITE_PATH` to a writable file **outside any publicly served directory**. The server creates its parent directory. The default `data/` directory and local credentials are ignored by Git and blocked by the development file server.

1. On the private ElevenLabs agent, enable authentication, install the exact system prompt, and register the five tools as **client** tools using the names, descriptions, parameters, response requirement and timeout in the frozen contract. Enable the user transcript, agent response, audio, interruption and agent response correction client events. Enable audio alignment for the best interrupted-transcript coverage. [Agent prompt](agent/system_prompt.md) · [Tool definitions](contracts/tools.json) · [ElevenLabs authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
2. Run `npm run server` in one terminal. Node loads the local environment file and binds the API to 127.0.0.1 on port 8787.
3. Run `npm run dev` in a second terminal and open the printed localhost URL. Vite proxies `/api` to the backend. For a production-build check, use `npm run build` followed by `npm run preview` with the same API running.
4. Select **Start Voice**, grant microphone access and ask for an order. Listen to the full readback and say yes to capture. **End Session** closes audio and flushes the remaining transcript. After a disconnect, **Start Voice** creates a fresh session.

## Implementation

The API implements the nine operations under `/api`. The private signed-URL exchange is the backend’s only outbound network call. The browser uses the returned WebSocket URL once and holds the session credentials in memory. Each tool wrapper shares a nine-second deadline across queueing, transcript sync and retry. A retry uses the original idempotency key. The wrapper records its answer locally before returning it to the agent, then flushes the audit entry and refreshes the dashboard. The dashboard loads the latest 50 capture and query records. [HTTP contract](contracts/api.yaml)

The SQLite repository encapsulates sessions, sequenced transcript entries, intents and response replays. Capture checks and writes run in a single transaction. Session tokens are stored as hashes. Confirmation expires 120 seconds after the first server receipt of the yes. The browser timestamp remains in the transcript for audit. Reposting an entry preserves its original receipt time. Existing databases migrate on startup, and a pre-migration yes requires a fresh readback and confirmation. Query handlers use the catalog in the frozen OpenAPI document. The service validates request bodies against that document and each intent against the frozen JSON Schema before storage. [Intent schema](contracts/intent.schema.json)

## Verification

```sh
npm test
npm run build
```

The HTTP suite uses local servers, real SQLite and an injected signing response. It exercises the nine operations, the schema examples, transcript sequence conflicts, session isolation and expiry, confirmation evidence, cancellation resolution, duplicate captures and retries. The dashboard tests drive the UI with a mocked microphone, SDK and API, including denial, dropped connections, reconnection, interrupted playback, closing mid-sentence and tool failures. The frozen spot-order eval supplies a multi-turn API fixture. [Conversation evals](evals/utterances.json)

## Review gaps and TODOs

- Run a real private-agent session with a microphone, including an interrupted readback and reconnect. Verify agent replies and tool decisions against the complete conversation eval set. The automated tests cover application behavior using simulated provider events.
- The frozen search request allows 120 characters while its required raw audit instrument allows 64. The API returns `400 invalid_parameters` if the audit record cannot satisfy the schema. The same applies when a fallback audit utterance is absent, empty or over 2,000 characters. Resolve the conflicting limits in a future contract revision.
- Browser playback tests inject SDK events. If the user's yes arrives ahead of a playback completion or correction, the browser waits up to 250 milliseconds for that evidence before sending the turn to the backend. A missing completion needs a fully played alignment. Incomplete evidence records only the known prefix, with the interrupted flag, and requires a new readback. A correction to the most recently stored response closes the session. Actual provider timing, including corrections arriving after a capture has already committed, still needs live audio verification.
- A transport timeout can occur after SQLite accepts a capture. The client attempts to refresh the dashboard, and replaying the same key returns the original result. A disconnected browser can miss that refresh or its final transcript flush. Idle and absolute expiry still apply on the server.
- The frozen wrapper returns each tool response verbatim. A successful capture includes the session ID inside the returned intent. The bearer token stays outside all tool results. The provider’s signed URL may itself contain the agent ID.

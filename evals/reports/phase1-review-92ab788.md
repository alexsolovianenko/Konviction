# Phase 1 review: diff 856a0e4..92ab788

Reviewer: Claude Fable (contracts owner), branch `phase1-fable`. Date: 2026-11-19.
Implementation under review: `92ab788` on `phase1-codex`, tested in the OpenAI-Codex sibling checkout, which was not modified.

## Result

- **Local review: complete.** The diff implements the nine frozen operations and the five handlers, stays inside the capture-only scope, and makes no Gemini call. `npm test` in the sibling checkout passes (10 server tests, 8 dashboard tests) and `tsc --noEmit` is clean.
- **Live agent run: blocked.** No ElevenLabs credentials exist on this machine for this project (details below), so none of the 68 cases was run against a live agent, in text or in audio.
- **Substitute run: contract replay, 68 of 68 pass.** Each case's scripted user turns, expected agent replies and expected tool calls were replayed against the real Codex backend. This checks the backend and the evals against each other. It does not check what the model says or decides.
- Nine code fixes are flagged for Codex, two of them likely to break captures in real use. Four contract clarifications are proposed and not applied, because the contracts are frozen.
- Prompt and eval fixes are committed on `phase1-fable`. Nothing was merged to main.

## Exact live blocker

`ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` are not available:

- no `.env` in `OpenAI-Codex`, `Claude-Fable` or the main checkout; the only env file is `OpenAI-Codex/.env.example`, with empty values;
- neither variable is set in the worker's process environment.

No key was read or printed, no agent was created, and no existing agent was touched. To unblock: put an API key that may create agents in `OpenAI-Codex/.env` (server side, git-ignored). The plan is then to create one dedicated agent named for Phase 1 review with the prompt and five client tools, start the Codex server with `ELEVENLABS_AGENT_ID` pointing at it, and drive the 68 cases over the signed WebSocket in text-only mode with the harness posting transcripts as the browser does. Audio needs a person with a microphone in the dashboard as well.

## What the three columns mean

| Column | What ran | Status |
| --- | --- | --- |
| Contract replay | Real Codex backend, in process, in-memory SQLite, fake signer. No model, no audio. Agent replies are the eval's expected replies. | Ran, 68 cases |
| Live text | Dedicated live agent over WebSocket, typed user turns, real model and tools. | Blocked, no credentials |
| Audio | Browser, microphone, speech recognition, playback, interruption. | Blocked, no credentials and needs a person |

"Capture probes" are extra attempts made by the harness: on each turn where the eval forbids a capture, it tries to capture the most recent readback anyway and records the backend's refusal code. A probe that succeeded would be a failure. None did.

## Per-case results

| Case | Contract replay | Evidence (expected calls) | Capture probes (must be refused) | Live text | Audio | Note |
| --- | --- | --- | --- | --- | --- | --- |
| spot-01 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| spot-02 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| spot-03 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| spot-04 | pass | capture_order 201 | n/a | blocked | blocked |  |
| spot-05 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | Failed at 856a0e4 with utterance_mismatch; eval and prompt fixed. |
| spot-06 | pass | no tool call expected | n/a | blocked | blocked |  |
| spot-07 | pass | capture_order 201 | n/a | blocked | blocked |  |
| spot-08 | pass | search count 0 | n/a | blocked | blocked |  |
| spot-09 | pass | no tool call expected | t3 confirmation_missing | blocked | blocked |  |
| spot-10 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| spot-11 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| spot-12 | pass | no tool call expected | n/a | blocked | blocked |  |
| pred-01 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| pred-02 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| pred-03 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked |  |
| pred-04 | pass | search count 2; capture_order 201 | n/a | blocked | blocked |  |
| pred-05 | pass | no tool call expected | n/a | blocked | blocked |  |
| pred-06 | pass | no tool call expected | n/a | blocked | blocked |  |
| pred-07 | pass | no tool call expected | n/a | blocked | blocked |  |
| pred-08 | pass | no tool call expected | n/a | blocked | blocked |  |
| pred-09 | pass | search count 1 | n/a | blocked | blocked |  |
| conf-01 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked |  |
| conf-02 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked |  |
| conf-03 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked |  |
| conf-04 | pass | search count 1 | t2 confirmation_missing; t3 confirmation_missing | blocked | blocked |  |
| conf-05 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| conf-06 | pass | search count 1; capture_order 201 | n/a | blocked | blocked |  |
| conf-07 | pass | search count 1; capture_order 201; capture_order 201 | t3 confirmation_missing | blocked | blocked | Failed at 856a0e4 with utterance_mismatch; eval and prompt fixed. |
| conf-08 | pass | search count 1; search count 1 | t2 confirmation_missing; t3 confirmation_missing; t4 readback_missing | blocked | blocked |  |
| conf-09 | pass | search count 1; capture_order 201; status count 1 | n/a | blocked | blocked |  |
| conf-10 | pass | search count 1; capture_order mocked | t3 confirmation_missing | blocked | blocked |  |
| conf-11 | pass | search count 1 | n/a | blocked | blocked |  |
| cancel-01 | pass | capture_cancel 201 | n/a | blocked | blocked |  |
| cancel-02 | pass | status count 0; status count 0 | n/a | blocked | blocked |  |
| cancel-03 | pass | status count 1; capture_cancel 201 | n/a | blocked | blocked |  |
| cancel-04 | pass | status count 2; capture_cancel 201 | n/a | blocked | blocked |  |
| cancel-05 | pass | status count 2; capture_cancel 201 | t2 confirmation_missing | blocked | blocked |  |
| cancel-06 | pass | status count 1; status count 1 | n/a | blocked | blocked |  |
| cancel-07 | pass | no tool call expected | n/a | blocked | blocked |  |
| cancel-08 | pass | status count 1 | n/a | blocked | blocked |  |
| cancel-09 | pass | status count 1 | t2 confirmation_missing | blocked | blocked |  |
| cancel-10 | pass | capture_cancel 201 | t2 confirmation_missing | blocked | blocked |  |
| cancel-11 | pass | status count 1 | n/a | blocked | blocked |  |
| status-01 | pass | status count 1 | n/a | blocked | blocked |  |
| status-02 | pass | status count 0 | n/a | blocked | blocked |  |
| status-03 | pass | status count 0 | n/a | blocked | blocked |  |
| status-04 | pass | status count 1; status count 1 | n/a | blocked | blocked |  |
| status-05 | pass | search count 1; capture_order 201; status count 1 | n/a | blocked | blocked |  |
| mkt-01 | pass | search count 1 | n/a | blocked | blocked |  |
| mkt-02 | pass | search count 1; book 3410.5/3411 | n/a | blocked | blocked |  |
| mkt-03 | pass | search count 2 | n/a | blocked | blocked |  |
| mkt-04 | pass | search count 0 | n/a | blocked | blocked |  |
| mkt-05 | pass | search count 1; book 0.3/0.32 | n/a | blocked | blocked |  |
| mkt-06 | pass | no tool call expected | n/a | blocked | blocked |  |
| mkt-07 | pass | no tool call expected | n/a | blocked | blocked |  |
| mkt-08 | pass | search count 2 | n/a | blocked | blocked |  |
| scope-01 | pass | search count 1 | n/a | blocked | blocked |  |
| scope-02 | pass | no tool call expected | n/a | blocked | blocked |  |
| scope-03 | pass | search count 1 | n/a | blocked | blocked |  |
| scope-04 | pass | no tool call expected | n/a | blocked | blocked |  |
| scope-05 | pass | no tool call expected | n/a | blocked | blocked |  |
| scope-06 | pass | search count 1 | n/a | blocked | blocked |  |
| scope-07 | pass | search count 1 | n/a | blocked | blocked |  |
| scope-08 | pass | search mocked | n/a | blocked | blocked |  |
| scope-09 | pass | search count 1; capture_order 201 | t2 confirmation_missing; t3 readback_missing | blocked | blocked |  |
| scope-10 | pass | no tool call expected | n/a | blocked | blocked |  |
| scope-11 | pass | no tool call expected | n/a | blocked | blocked |  |
| scope-12 | pass | search count 1; capture_order 201 | t3 confirmation_missing | blocked | blocked |  |

Cases with no tool call and no probe pass the replay trivially: they can only be judged on what the model says, so their real verdict is the blocked live column.

## Code fixes for Codex

Ordered by how likely they are to break a real session.

1. **Browser clock ahead of the server rejects every capture** (`server/tools.mjs`, `age >= 0`). A yes timestamped 2 seconds ahead of the server clock returns `confirmation_missing`. The contract only says at most 120 seconds old. Harmless when browser and server share a clock, fatal on any deployment with skew. Record a server receipt time per transcript entry and use that for the 120-second window.
2. **A complete readback can be stored as interrupted** (`src/voice.ts`, `finish(interrupted || speaking || draft !== undefined)`). If the listening mode change has not closed the draft when the user's yes arrives, or alignment text differs from the response text, the readback is saved with `interrupted: true` and the heard text, which is empty without alignment. The backend then answers `readback_interrupted` or `readback_missing` (both confirmed by probe). Mark an entry interrupted only on an interruption or correction event. This is the transcript fallback caveat in the README and can only be settled in an audio session.
3. **A yes split across two user transcript entries is refused** (`readback_missing`). "um" then "yes", or "yes" twice as separate entries, fails because the entry before the last user entry is a user entry. See contract proposal A.
4. **Search with no word of three or more characters returns the whole catalog.** Query "bt" returns BTCUSD, ETHUSD and SOLUSD. It should return nothing.
5. **Search fails on generic words.** "recession market", "fed cut market" and "bitcoin spot" return 0 because every word must match. This follows the frozen rule; the prompt now tells the agent to leave such words out. See contract proposal C for a stop-word list.
6. **Audit-length conflict.** A search query of 65 to 120 characters returns `400 invalid_parameters` because the audit intent's `instrument` is capped at 64. Confirmed: 64 characters succeeds, 65 fails. See contract proposal B.
7. **Fallback utterance.** A query tool called before any user entry, or when the latest user entry is over 2,000 characters, returns `400` instead of answering. Confirmed for both. See contract proposal B.
8. **Wrapper can outlast the tool timeout** (`src/session.ts`). Two attempts of a 3.5-second flush plus a 3.5-second request is up to 14 seconds; the agent's tool timeout is 10.
9. **`get_order_status` with an `order_id` that normalizes to nothing** (for example "--") returns `400`. Treat it as no reference, or keep the 400 and say so in the contract.

Reviewed and found correct: validation order, idempotency replay and key reuse, one confirmation per intent, duplicate capture returning 200, cancel resolution and `cancel_already_captured`, session isolation and expiry, token hashing, quote folding, cent and dollar readback matching, spoken order references, and the 127.0.0.1 bind.

## Explicit-yes behavior observed

Accepted: "Yes.", "Yes, please.", "Yeah, that's right." (curly apostrophe), "Yes, I confirm.", "yes yes", "Yes, that is correct.", "Yes it is.", "Yes, confirmed, thanks.", "yeah do that", "Yes?".

Refused as `confirmation_missing`: "Okay.", "Correct.", "Affirmative.", "Yes, sounds good.", "Yes, place it.", "Yes, go ahead and do it." (the word "and"), "uh yes", "um, yes".

The last three are natural spoken confirmations. The agent recovers by reading back again, but it costs the user a turn. See contract proposal A. "Yes?" being accepted is a judgment call the coordinator may want to reverse.

## Readback formats observed

Accepted: the template; "97,000 dollars"; "1.0" and "97000.00"; a sentence before or after the readback.
Refused as `readback_mismatch`: "$97,000" without the word dollars; numbers written as words; "BTC USD" with a space. The prompt now states digits and the exact instrument string more firmly.

## Provider payload caveats

- **Session ID reaches the model.** A successful capture returns the stored intent, which includes `session_id`, and the wrapper returns tool results verbatim. The contract says the model is never given it. The ID is not a credential (the bearer token is, and it never appears in a tool result), so the risk is low. The prompt now forbids speaking any identifier from a tool result.
- **Agent ID is visible in the signed URL.** This is how the provider's signed URLs work. With authentication enabled on the agent, the ID alone cannot start a conversation.
- **Tool results are stored in the transcript and shown in the dashboard** under "Simulated tool result". They contain no secrets.

## Contract proposals (not applied; contracts are frozen at 856a0e4)

A. **Confirmation entry.** Define C as the trailing run of consecutive user entries joined with spaces, and R as the agent entry before that run. Add "uh", "um", "er", "ah", "oh", "well", "and", "so" to `allowed_fillers`. The backend reads the filler list from `api.yaml`, so the list change needs no code.
B. **Audit records never fail a query.** The audit `instrument` for `search_markets` is the first 64 characters of the query. A fallback utterance is cut to 2,000 characters. With no user entry, the supplied utterance is stored as given.
C. **Search matching.** Ignore the words market, markets, contract, contracts, price, spot, prediction, gemini, the, on, for and of. A query with no remaining word of three or more characters matches nothing.
D. **Wording.** Replace "the model is never given either value" with: the session token is never given to the model; the session ID appears in returned intents and is not a credential. Note that the signed URL contains the agent ID.

## Prompt and eval fixes made on this branch

- **Utterance must be one unbroken stretch.** The frozen rule requires a contiguous substring of the user transcript, but the prompt and two evals (spot-05, conf-07) joined non-adjacent turns, which the backend refuses with `utterance_mismatch`. The prompt now explains the rule; the two evals were corrected.
- **Search queries** contain only the asset or event words, with one retry using fewer words.
- **Identifiers from tool results are never spoken.**
- **Readback** numbers are digits and the instrument is written exactly as returned.

## Not verified

- Any model behavior: the refusal sentence, asking for missing values, not guessing, reply length, the fixed capture sentence. All 68 live verdicts are blocked.
- Speech recognition output, interruption handling, alignment, playback, reconnect.
- Whether the installed SDK delivers the events in the order `src/voice.ts` assumes. The callbacks it uses do exist in `@elevenlabs/client` 1.37.1.

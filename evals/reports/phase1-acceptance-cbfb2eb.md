# Phase 1 acceptance review: implementation cbfb2eb against contracts 6582824

Reviewer: Claude Fable (contracts owner), branch `phase1-fable`. Date: 2026-11-19.
Reviewed: `cbfb2eb` on `phase1-codex` (history: `92ab788`, `26158fd`, merge of `6582824`, `cbfb2eb`). The Codex checkout was clean at `cbfb2eb` and was not modified. Independent replays ran from a fresh temporary copy of the committed files.

## Verdict

- **Local acceptance: pass.** No actionable defect found. The implementation matches contract revision 1.1.0 and all nine findings of the first review are resolved.
- **Live acceptance: blocked, for every case.** The ElevenLabs API key cannot use the Agents API and no agent ID is configured. No live text run, no spoken-input check, no returned-audio check and no device-playback check was possible.
- **Full review has therefore not passed. Do not merge to main yet.**

## Artifacts

- `contracts/`, `agent/system_prompt.md` and `evals/` at `cbfb2eb` are byte-identical to the frozen `6582824` (empty `git diff`).
- The server reads the yes words, fillers, catalog and error codes from the frozen `api.yaml`, and the HTTP test suite runs every entry of `backend_regressions` from the frozen eval file.

## Test evidence

| Evidence | Result |
| --- | --- |
| `npm test`, server suite (run by me at `cbfb2eb`) | 51 of 51 pass, including all 35 frozen backend regressions |
| `npm test`, dashboard and session suite | 18 of 18 pass |
| `tsc --noEmit` | clean |
| `vite build` (output to a temporary directory) | builds |
| My conversation replay, 84 cases, real backend, no model | 84 of 84 pass |
| My direct backend checks, 35 | 35 of 35 pass |
| My capture probes on every turn where capture is forbidden | all refused |

At the previous stable commit `26158fd` the same runs gave 82 of 84 and 21 of 35.

## Prior findings

| # | Finding from the first review | Status at cbfb2eb | Evidence |
| --- | --- | --- | --- |
| 1 | Browser clock ahead of server rejects captures | Fixed | Window uses backend receipt time; 2 s ahead and 130 s behind both capture; 121 s of backend time is refused, 119 s accepted |
| 2 | Complete readback stored as interrupted | Fixed in code, unverified live | Entry is interrupted only without a playback end or a fully played alignment; injected-event tests pass. Real provider timing is untested |
| 3 | Yes split across two entries refused | Fixed | `um` + `yes` and `yes` + `yes please` capture; `yes` + `but make it two`, `no` + `yes`, `yes` + question are refused |
| 4 | Short query returns the whole catalog | Fixed | `bt` and `the market` return 0 |
| 5 | Generic words break search | Fixed | `recession market`, `fed cut market`, `bitcoin spot` each return 1 |
| 6 | 65 to 120 character query returns 400 | Fixed | 120 characters returns 200; audit instrument is the first 64 code points |
| 7 | Fallback utterance failures | Fixed | 2,500-character entry gives a 2,000-character audit copy and the transcript keeps 2,500; no user speech gives `422 utterance_mismatch` with nothing stored |
| 8 | Wrapper could outlast the 10 s tool timeout | Fixed | One 9-second budget from tool invocation across queueing, sync and retry |
| 9 | Status reference that normalizes to nothing | As specified | `--` returns `400 invalid_parameters`, nothing stored |

Also checked: "Yes?" and "yes, right?" are refused; an interrupted or empty readback is refused; a readback with numbers written as words is refused; transcript entries are stored exactly as posted.

## Observations (not defects)

1. **One deliberate tightening beyond the contract.** The contract binds a confirmation to the seq of its last entry. The code treats any earlier capture inside the same run of user entries as the same confirmation, so a late speech-recognition fragment cannot create a second intent. This is stricter than the text and in line with its intent. I will fold it into the contract wording at the next revision; no code change is wanted.
2. **Timeout after commit.** If the backend commits a capture but the response is lost for the whole 9-second budget, the agent is told the service was unreachable. The dashboard refresh then shows the intent, and a retry with the same key returns the original. A user who simply repeats the order by voice would prepare a second one. This is capture only, visible in the dashboard, and documented in the README.
3. **`POST /voice/signed-url` is unauthenticated**, as the contract says. The server binds to 127.0.0.1. Any wider deployment needs a gate in front of it.
4. **Playback evidence logic in `src/voice.ts`** (250 ms grace, alignment comparison, correction after sync closing the session) is covered only by injected SDK events.

## Live provider readiness

Checked server-side on 2026-11-19 by loading `/Users/alex/CLionProjects/UBC-Hackathon/.env` with `node --env-file` and printing only variable names, HTTP status and error status. The key was not printed, copied or written anywhere.

| Check | Result |
| --- | --- |
| `ELEVENLABS_API_KEY` | set |
| `ELEVENLABS_AGENT_ID` | not set |
| `GET /v1/convai/agents` | `401 missing_permissions` (lacks `convai_read`) |
| `GET /v1/convai/conversation/get-signed-url` | `401 missing_permissions` (lacks `convai_write`) |
| `GET /v1/user` | `401 missing_permissions` (lacks `user_read`) |
| `GET /v1/models` | `401 missing_permissions` (lacks `models_read`) |

Without `convai_write` the backend cannot obtain a signed URL, so `POST /api/voice/signed-url` would answer `502 elevenlabs_unavailable` and no conversation can start. Without `convai_read` and an agent ID, no dedicated agent can be found, created or configured. No agent was created or altered.

To unblock: a key with Agents (convai) read and write permission, and either an agent ID for a dedicated Phase 1 agent or permission to create one.

## Live verification status by kind

| Kind | What it would prove | Status | Reason |
| --- | --- | --- | --- |
| Live text | The model's replies and tool decisions for each case | Blocked, all 84 | `401 missing_permissions` on the Agents API; no agent ID |
| Spoken input transcript | Speech sent to the agent comes back as the expected user transcript | Blocked, all 84 | Same; no conversation can be opened |
| Returned audio is non-silent | The agent's audio frames carry signal, checked on the received bytes | Blocked, all 84 | Same |
| Device playback | A person hears the audio from the speakers and can interrupt it | Blocked, all 84 | Same, and needs a person at the device; it cannot be verified by a script even once the key works |

## Per-case results

Local replay ran for every case. Every live column is blocked for the reason above.

| Case | Local replay | Evidence (expected calls) | Capture probes (must be refused) | Live text | Spoken input transcript | Returned audio non-silent | Device playback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spot-01 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-02 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-03 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-04 | pass | capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-05 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-06 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| spot-07 | pass | capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-08 | pass | search count 0 | n/a | blocked | blocked | blocked | blocked |
| spot-09 | pass | none expected | t3 confirmation_missing | blocked | blocked | blocked | blocked |
| spot-10 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-11 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| spot-12 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| pred-01 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| pred-02 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| pred-03 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| pred-04 | pass | search count 2; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| pred-05 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| pred-06 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| pred-07 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| pred-08 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| pred-09 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| conf-01 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| conf-02 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| conf-03 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| conf-04 | pass | search count 1 | t2 confirmation_missing; t3 confirmation_missing | blocked | blocked | blocked | blocked |
| conf-05 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| conf-06 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| conf-07 | pass | search count 1; capture_order 201; capture_order 201 | t3 confirmation_missing | blocked | blocked | blocked | blocked |
| conf-08 | pass | search count 1; search count 1 | t2 confirmation_missing; t3 confirmation_missing; t4 readback_missing | blocked | blocked | blocked | blocked |
| conf-09 | pass | search count 1; capture_order 201; status count 1 | n/a | blocked | blocked | blocked | blocked |
| conf-10 | pass | search count 1; capture_order mocked | t3 confirmation_missing | blocked | blocked | blocked | blocked |
| conf-11 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| cancel-01 | pass | capture_cancel 201 | n/a | blocked | blocked | blocked | blocked |
| cancel-02 | pass | status count 0; status count 0 | n/a | blocked | blocked | blocked | blocked |
| cancel-03 | pass | status count 1; capture_cancel 201 | n/a | blocked | blocked | blocked | blocked |
| cancel-04 | pass | status count 2; capture_cancel 201 | n/a | blocked | blocked | blocked | blocked |
| cancel-05 | pass | status count 2; capture_cancel 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| cancel-06 | pass | status count 1; status count 1 | n/a | blocked | blocked | blocked | blocked |
| cancel-07 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| cancel-08 | pass | status count 1 | n/a | blocked | blocked | blocked | blocked |
| cancel-09 | pass | status count 1 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| cancel-10 | pass | capture_cancel 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| cancel-11 | pass | status count 1; capture_cancel 201; capture_order 201 | t3 confirmation_missing | blocked | blocked | blocked | blocked |
| status-01 | pass | status count 1 | n/a | blocked | blocked | blocked | blocked |
| status-02 | pass | status count 0 | n/a | blocked | blocked | blocked | blocked |
| status-03 | pass | status count 0 | n/a | blocked | blocked | blocked | blocked |
| status-04 | pass | status count 1; status count 1 | n/a | blocked | blocked | blocked | blocked |
| status-05 | pass | search count 1; capture_order 201; status count 1 | n/a | blocked | blocked | blocked | blocked |
| mkt-01 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| mkt-02 | pass | search count 1; book 3410.5/3411 | n/a | blocked | blocked | blocked | blocked |
| mkt-03 | pass | search count 2 | n/a | blocked | blocked | blocked | blocked |
| mkt-04 | pass | search count 0 | n/a | blocked | blocked | blocked | blocked |
| mkt-05 | pass | search count 1; book 0.3/0.32 | n/a | blocked | blocked | blocked | blocked |
| mkt-06 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| mkt-07 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| mkt-08 | pass | search count 2 | n/a | blocked | blocked | blocked | blocked |
| scope-01 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| scope-02 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| scope-03 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| scope-04 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| scope-05 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| scope-06 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| scope-07 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| scope-08 | pass | search mocked | n/a | blocked | blocked | blocked | blocked |
| scope-09 | pass | search count 1; capture_order 201 | t2 confirmation_missing; t3 readback_missing | blocked | blocked | blocked | blocked |
| scope-10 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| scope-11 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| scope-12 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| reg-01 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| reg-02 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| reg-03 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| reg-04 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| reg-05 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| reg-06 | pass | search count 1 | t2 confirmation_missing; t3 confirmation_missing | blocked | blocked | blocked | blocked |
| reg-07 | pass | search count 1; capture_order 201 | t2 confirmation_missing | blocked | blocked | blocked | blocked |
| reg-08 | pass | search count 1; search count 1 | n/a | blocked | blocked | blocked | blocked |
| reg-09 | pass | search count 1 | n/a | blocked | blocked | blocked | blocked |
| reg-10 | pass | none expected | n/a | blocked | blocked | blocked | blocked |
| reg-11 | pass | status count 0 | n/a | blocked | blocked | blocked | blocked |
| reg-12 | pass | search count 1; capture_order 201 | t3 confirmation_missing; t4 confirmation_missing | blocked | blocked | blocked | blocked |
| reg-13 | pass | search count 1; capture_order 201 | n/a | blocked | blocked | blocked | blocked |
| reg-14 | pass | search count 2 | n/a | blocked | blocked | blocked | blocked |
| reg-15 | pass | status count 0 | n/a | blocked | blocked | blocked | blocked |
| reg-16 | pass | none expected | n/a | blocked | blocked | blocked | blocked |

Cases with no tool call and no probe pass the local replay trivially; only the live text run can judge them.

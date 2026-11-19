# Call-to-Predict

UBC Austin 2026 hackathon project.

Working window: November 18–20, 2026     Team: Two developers
Submission deadline: Friday, November 20 at 12:00 PM CST (1:00 PM Toronto time)

## Product idea

Prediction markets usually require users to browse contracts, compare terms, and enter orders on screen. Call-to-Predict lets a user talk through those steps and review the exact proposed order on the dashboard.

Every order, cancellation and status request concerns a YES or NO event contract on Gemini Predictions. BTC/USD prices provide read-only context. The current browser demo simulates market data, previews contracts and captures requests for later approval.

The longer-term project is a voice-first prediction-market trading assistant. Users speak to an ElevenLabs agent by phone or web, browse real Gemini
markets, request optional external research, and explicitly authorize an order. The agent may spend limited test USDC on Arc
via x402 to buy useful research; Gemini remains the core trading venue.

### Executive decisions

- Preserve the existing Lovable dashboard. Connect it to one shared secure backend and GitHub repository.
- Prove Gemini market data immediately, then verify actual Predictions sandbox order access. Generic exchange sandbox
access alone is not proof.
- Make browser-based ElevenLabs conversations work before adding Twilio telephone calls.
- Treat Arc x402 as one relevant optional research purchase, not a second trading platform.
- Do not expose private keys or place production trades. Use permissioned sandbox access and explicit order authorization.
- Ship a public repository, documented working demo, 2–3 minute video, and Devpost submission before noon CST Friday.

Document status: Build plan and technical design. API availability and sandbox permissions must be checked in the team’s accounts before claims of working integrations.


## The technology stack

| Component | Responsibility |
| --- | --- |
| Lovable | Existing dashboard, market screens, approval UX, and Call Me control. |
| GitHub | Shared repository, collaboration, technical source of truth, public submission. |
| Lovable Cloud / Supabase | Secure server-side functions, API authentication, data storage, and secrets. |
| Gemini Exchange / Predictions | Event discovery, prices, contract terms, permitted account data, sandbox orders. |
| ElevenLabs | Conversational voice agent, tools, speech and responses. |
| Twilio | Actual inbound/outbound phone calls to consenting participants. |
| Arc + Circle + x402 | USDC payments for selected external research services. |
| QuickNode (optional) | Arc Streams payment monitoring if pursuing that optional bounty. |

## System architecture

The dashboard and the phone agent must call the same application backend. Neither should independently sign Gemini
requests or hold the trading secrets.
**Entry points** User → Lovable dashboard OR phone → Twilio → ElevenLabs agent.
SHARED APPLICATION BACKEND  Auth, Gemini adapter, preview/approval, order execution, research purchases, audit
events.

**Gemini path** Backend → Gemini Prediction Markets API → markets, prices, preview inputs, permitted sandbox orders and order status.

**Arc path** Backend agent → paid research API / x402 → approved Arc USDC payment → verified content and settlement evidence.

**Outputs** Backend → Lovable dashboard and ElevenLabs → actual market data, approved trade status, research links and payment receipts.

### Architecture rule

One order engine, one audit trail, and one set of risk controls. Voice and dashboard are two interfaces to the same backend.
Arc payments and Gemini trades remain separate financial systems.

## What the final demo should show

1.  A consenting user receives or initiates a phone call with the ElevenLabs agent.
2.  The user asks for a Gemini prediction market. The agent retrieves real event details and prices, never improvising figures.
3.  The user requests additional evidence. If a relevant paid resource exists, the agent authorizes a small x402 test USDC
purchase on Arc.
4.  The agent explains the external information alongside the Gemini contract, identifying sources, terms, and uncertainty.
5.  The user requests a trade. The agent repeats contract, YES/NO side, limit price, quantity, maximum cost and asks for
approval.
6.  The backend validates the exact authorized order and sends it to Gemini’s sandbox if Predictions trading is enabled.
7.  The app shows confirmed order status (or an explicitly labeled simulation), together with separate Arc payment evidence.

## Official links and documentation

- UBC Hackathon Devpost
- Gemini Prediction Markets API specification
- Gemini Demo environment (Sandbox)
- Gemini Sandbox exchange website
- ElevenLabs Agents overview
- ElevenLabs webhook tools
- ElevenLabs native Twilio integration
- Lovable GitHub integration
- Lovable Cloud backend and secrets
- Circle Arc Nanopayments reference repository
- Circle agent services
- Arc / Circle faucet

The PDF lists these references by name without embedded destination URLs.

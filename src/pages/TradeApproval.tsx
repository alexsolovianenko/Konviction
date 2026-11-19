import { useEffect, useState } from "react";
import { PIN_PATTERN, tradingRequest, type Proposal, type Availability } from "../browserTrading";

export function TradeApproval({
  proposal,
  availability,
  message,
  approve,
}: {
  proposal: Proposal | null;
  availability: Availability | null;
  message: string;
  approve: (id: string, pin: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<Availability | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    let live = true;
    void tradingRequest("availability").then((r) => {
      if (live) setStatus(r);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    setPin("");
    setExpired(false);
    if (!proposal) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(proposal.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [proposal]);
  const config = availability ?? status;
  return (
    <section aria-label="Sandbox trade approval">
      <h2>Sandbox trade proposal</h2>
      <a href="/open-trades" target="_blank" rel="noreferrer">
        Open trades and positions ↗
      </a>
      <p>{config?.message ?? "Checking sandbox trading availability…"}</p>
      {proposal && (
        <>
          <strong>
            {proposal.title} · {proposal.contract_label}
          </strong>
          <p>{proposal.readback}</p>
          <p>
            {proposal.instrument_symbol} · Quoted at {Math.round(proposal.quote_price * 100)}¢ ·
            Expires {new Date(proposal.expires_at).toLocaleTimeString()}
          </p>
          {expired ? (
            <p>Proposal expired. Ask for a fresh quote.</p>
          ) : (
            config?.execution_enabled && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (pending || !PIN_PATTERN.test(pin)) return;
                  setPending(true);
                  setPin("");
                  try {
                    await approve(proposal.proposal_id, pin);
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <p>Type your PIN here. Keep it out of the voice conversation.</p>
                <label>
                  Private approval PIN{" "}
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    pattern="[0-9]{4,8}"
                    maxLength={8}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                  />
                </label>
                <button disabled={pending || !PIN_PATTERN.test(pin)}>Approve sandbox buy</button>
              </form>
            )
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

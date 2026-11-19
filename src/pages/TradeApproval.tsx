import { useEffect, useState } from "react";
import { ArrowUpRight, LockKeyhole } from "lucide-react";
import { PIN_PATTERN, tradingRequest, type Proposal, type Availability } from "../browserTrading";
import { cents, usd } from "../lib/format";

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
  let approvalStatus = config?.message ?? "Checking sandbox trading availability…";
  if (proposal && config?.execution_enabled) {
    approvalStatus = pending ? "Submitting sandbox order…" : expired ? "Approval expired" : "Awaiting your private approval";
  }
  return (
    <section
      aria-label="Sandbox trade approval"
      className={"min-w-0 " + (proposal ? "rounded-lg border bg-card p-4 " + (expired ? "border-border" : "border-primary") : "")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <p aria-live="polite" className={proposal ? "min-w-0 font-semibold" : "min-w-0 text-muted-foreground"}>
          <span className="sr-only">Sandbox trade proposal. </span>
          {approvalStatus}
        </p>
        <a
          href="/open-trades"
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-accent-foreground hover:underline"
        >
          Open trades and positions <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      </div>
      {proposal && (
        <div className="mt-4 space-y-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {proposal.title} · {proposal.contract_label}
            </h2>
            <p className="mt-0.5 text-sm text-subtle">{proposal.readback}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            {(
              [
                ["Outcome", String(proposal.outcome).toUpperCase()],
                ["Contracts", String(proposal.quantity)],
                ["Limit", cents(proposal.limit_price)],
                ["Max. cost incl. est. fee", usd(proposal.notional_usd + proposal.est_fee_usd)],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="tnum break-words text-xs text-muted-foreground">
            {proposal.instrument_symbol} · Quoted at {Math.round(proposal.quote_price * 100)}¢ ·
            Expires {new Date(proposal.expires_at).toLocaleTimeString()}
          </p>
          {expired ? (
            <p className="text-sm text-warning">Proposal expired. Ask for a fresh quote.</p>
          ) : (
            config?.execution_enabled && (
              <form
                className="border-t border-border pt-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (pending || !PIN_PATTERN.test(pin)) return;
                  if (Date.parse(proposal.expires_at) <= Date.now()) {
                    setExpired(true);
                    return;
                  }
                  setPending(true);
                  setPin("");
                  try {
                    await approve(proposal.proposal_id, pin);
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
                  Enter your private PIN and approve to send this order to Gemini Sandbox.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="flex w-44 flex-col gap-1 text-xs text-muted-foreground">
                    Private approval PIN
                    <input
                      className="field tracking-[0.3em]"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      pattern="[0-9]{4,8}"
                      maxLength={8}
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                    />
                  </label>
                  <button className="btn btn-primary" disabled={pending || !PIN_PATTERN.test(pin)}>
                    {pending ? "Submitting…" : "Approve sandbox buy"}
                  </button>
                </div>
              </form>
            )
          )}
        </div>
      )}
      {message && (
        <p role="status" className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}

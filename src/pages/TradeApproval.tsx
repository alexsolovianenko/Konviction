import { useEffect, useState } from "react";
import { ArrowUpRight, LockKeyhole, ShieldCheck } from "lucide-react";
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
  return (
    <section
      aria-label="Sandbox trade approval"
      className={"panel min-w-0 overflow-hidden " + (proposal && !expired ? "border-primary ring-4 ring-primary/10" : "")}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-6 sm:px-7">
        <h2 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
          <ShieldCheck className="size-6 text-primary" aria-hidden /> Sandbox trade proposal
        </h2>
        <a
          href="/open-trades"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          Open trades and positions <ArrowUpRight className="size-4" aria-hidden />
        </a>
      </header>
      <p className="px-5 pb-6 pt-1.5 text-sm text-muted-foreground sm:px-7">
        {config?.message ?? "Checking sandbox trading availability…"}
      </p>
      {proposal && (
        <div className="space-y-5 border-t border-border px-5 py-6 sm:px-7">
          <div>
            <strong className="display block text-3xl leading-tight sm:text-4xl">
              {proposal.title} · {proposal.contract_label}
            </strong>
            <p className="mt-2 text-base text-muted-foreground">{proposal.readback}</p>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {(
              [
                ["Outcome", String(proposal.outcome).toUpperCase()],
                ["Contracts", String(proposal.quantity)],
                ["Limit", cents(proposal.limit_price)],
                ["Est. cost + fee", `${usd(proposal.notional_usd)} + ${usd(proposal.est_fee_usd)}`],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-muted px-4 py-3">
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="tnum mt-0.5 text-lg font-semibold tracking-tight">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="tnum break-words text-xs text-muted-foreground">
            {proposal.instrument_symbol} · Quoted at {Math.round(proposal.quote_price * 100)}¢ ·
            Expires {new Date(proposal.expires_at).toLocaleTimeString()}
          </p>
          {expired ? (
            <p className="rounded-xl bg-warning/12 px-3 py-2 text-sm font-medium text-warning">Proposal expired. Ask for a fresh quote.</p>
          ) : (
            config?.execution_enabled && (
              <form
                className="rounded-3xl bg-primary-soft p-5"
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
                <p className="flex items-start gap-2 text-sm font-medium">
                  <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
                  Type your PIN here. Keep it out of the voice conversation.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm font-medium">
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
                  <button className="btn btn-primary h-12 px-6" disabled={pending || !PIN_PATTERN.test(pin)}>
                    Approve sandbox buy
                  </button>
                </div>
              </form>
            )
          )}
        </div>
      )}
      {message && (
        <p role="status" className="border-t border-border bg-primary-soft px-5 py-4 text-sm font-semibold sm:px-7">
          {message}
        </p>
      )}
    </section>
  );
}

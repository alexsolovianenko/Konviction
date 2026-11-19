import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { tradingRequest, type Proposal, type Availability } from "../browserTrading";
import { cents, usd } from "../lib/format";

export function TradeApproval({
  proposal,
  availability,
  message,
  remainderQuantity,
  retry,
}: {
  proposal: Proposal | null;
  availability: Availability | null;
  message: string;
  remainderQuantity?: number | null;
  retry?: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<Availability | null>(null);
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
    setExpired(false);
    if (!proposal) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(proposal.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [proposal]);
  const config = availability ?? status;
  const voiceReady = !!((config?.call_confirmation_supported || (config?.voice_confirmation_supported && config.voice_authorized)) && proposal?.voice_readback);
  let approvalStatus = config?.message ?? "Checking sandbox trading availability…";
  if (proposal && config?.execution_enabled) {
    approvalStatus = expired ? "Approval expired" : voiceReady ? "Awaiting spoken confirmation" : "Call confirmation unavailable";
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
          href="/dashboard"
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-accent-foreground hover:underline"
        >
          View account <ArrowUpRight className="size-3.5" aria-hidden />
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
          ) : voiceReady && config?.execution_enabled ? (
            <p className="border-t border-border pt-3 text-sm text-muted-foreground">Say “confirm” after hearing the order terms.</p>
          ) : null}
        </div>
      )}
      {message && (
        <p role="status" className="mt-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          {message}
        </p>
      )}
      {remainderQuantity && retry && (
        <button className="btn mt-2" onClick={() => void retry()}>
          Prepare remaining {remainderQuantity} {remainderQuantity === 1 ? "contract" : "contracts"}
        </button>
      )}
    </section>
  );
}

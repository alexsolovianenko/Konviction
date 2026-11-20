import { austinDateTime, shortHash } from "../../lib/format";
import type { ResearchQuote, ResearchView } from "../../quicknodeResearch";

const STATUS_TEXT: Record<ResearchQuote["status"], string> = {
  context_only: "No paid research · nothing charged",
  quoted: "Quoted · not paid",
  free: "Free response · no charge",
  expired: "Quote expired · nothing paid",
  reserved: "Budget reserved · starting payment",
  sending: "Payment in progress",
  paid: "Paid · data received",
  unknown_pending: "Payment status unknown · will not be retried",
  failed: "Did not complete · nothing paid",
};

const usdc = (atomic: string | null) => {
  if (atomic === null || !/^-?\d+$/.test(atomic)) return "—";
  const n = Number(atomic) / 1e6;
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0") + " USDC";
};
const num = (n: number | null | undefined, unit = "") =>
  n === null || n === undefined
    ? "—"
    : `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}${unit}`;
const signed = (n: number | null | undefined, unit = "%") =>
  n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n}${unit}`;

export function ResearchCard({
  research,
  onApprove,
  onRequestQuote,
}: {
  research: ResearchView;
  onApprove: () => void;
  /** Unpaid: asks the server for a session-bound price. Never pays. */
  onRequestQuote?: () => void;
}) {
  const q = research.quote;
  const a = q?.context.asset;
  return (
    <section
      aria-label="Crypto market research"
      className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold">
          {a ? `${a.name ?? a.symbol} (${a.symbol}) research` : "Market research"}
        </h3>
        {q && q.status !== "context_only" && (
          <span className="text-xs text-muted-foreground">{q.network_label} · testnet USDC</span>
        )}
      </div>
      {q && <Context q={q} />}
      {q && q.status !== "context_only" && <Paid q={q} />}
      {q?.status === "context_only" && research.canQuote && onRequestQuote && (
        <div className="mt-3">
          <button className="btn" disabled={research.busy} onClick={onRequestQuote}>
            Get paid {q.research_chain} research price
          </button>
        </div>
      )}
      {q?.status === "quoted" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="btn"
            disabled={!research.canApprove || research.busy}
            onClick={onApprove}
          >
            Approve {q.price_usdc} testnet USDC for {q.research_chain} research
          </button>
          <span className="text-xs text-muted-foreground">
            Paid from the server research wallet, not your trading balance.
          </span>
        </div>
      )}
      {q && q.limitations.length > 0 && (
        <ul aria-label="Research limitations" className="mt-3 grid gap-1 text-xs text-warning">
          {q.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {research.message && (
        <p role="status" className="mt-3 text-sm">
          {research.message}
        </p>
      )}
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        Research is not a trade. It never places or approves a Gemini order; any YES/NO trade needs
        its own approval.
      </p>
    </section>
  );
}

function Context({ q }: { q: ResearchQuote }) {
  const c = q.context;
  const m = c.market;
  const s = c.spot;
  return (
    <div className="mt-3 grid gap-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {(
          [
            [
              "Market",
              [m.title, m.contract_label].filter(Boolean).join(" · ") || "Selected market",
            ],
            ["Expiry", m.expiry ? austinDateTime(m.expiry) : "—"],
            [
              "Settles on",
              m.settlement_index
                ? `${m.settlement_agency ?? ""} ${m.settlement_index}`.trim()
                : "—",
            ],
            [
              "YES / NO buy",
              `${num(m.prices.yes_buy)} / ${num(m.prices.no_buy)} · implied YES ${num(c.implied_yes_pct, "%")}`,
            ],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 break-words text-xs">{v}</dd>
          </div>
        ))}
      </dl>
      {s && (
        <dl aria-label="Settlement index context" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Index last" value={num(s.last)} />
          <Metric label={`${s.minutes}-min change`} value={signed(s.change_60m_pct)} />
          <Metric
            label={`${s.minutes}-min realized vol`}
            value={num(s.realized_vol_60m_pct, "%")}
          />
          <Metric label="Strike vs index" value={signed(s.distance_to_strike_pct)} />
        </dl>
      )}
      {s && (
        <p className="text-xs text-muted-foreground">
          Source: {s.source}, 1-minute bars to {austinDateTime(s.as_of)}. Asset identified from{" "}
          {c.asset.identified_from.join(", ")}.
        </p>
      )}
    </div>
  );
}

function Paid({ q }: { q: ResearchQuote }) {
  const r = q.report;
  const ev = q.evidence;
  return (
    <div className="mt-3 grid gap-3 border-t border-border pt-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {(
          [
            ["Paid source", `${q.provider} · ${q.resource ?? "—"}`],
            ["Price", `${q.price_usdc} USDC`],
            ["Payment", STATUS_TEXT[q.status]],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 break-words text-xs">{v}</dd>
          </div>
        ))}
      </dl>
      {r && (
        <div className="grid gap-2">
          {r.comparison && (
            <dl className="grid grid-cols-3 gap-2">
              <Metric
                label={`Recent (${r.comparison.recent_window})`}
                value={`${num(r.comparison.recent)} ${r.comparison.unit}`}
              />
              <Metric
                label={`Previous (${r.comparison.previous_window})`}
                value={`${num(r.comparison.previous)} ${r.comparison.unit}`}
              />
              <Metric
                label="Change"
                value={
                  r.comparison.change_pct === null
                    ? "—"
                    : `${r.comparison.change_pct > 0 ? "+" : ""}${r.comparison.change_pct.toFixed(2)}%`
                }
              />
            </dl>
          )}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {r.metrics.map((x) => (
              <Metric key={x.label} label={x.label} value={`${num(x.value)} ${x.unit}`.trim()} />
            ))}
          </dl>
          <p className="text-xs">{r.headline}</p>
          <p className="text-xs text-muted-foreground">
            {r.chain} · {r.method}
            {r.coverage ? ` · ${r.coverage}` : ""} · observed{" "}
            <time dateTime={r.observed_at}>{austinDateTime(r.observed_at)}</time>
          </p>
          {r.warnings.length > 0 && <p className="text-xs text-warning">{r.warnings.join(" ")}</p>}
          <p className="text-xs">{r.disclaimer}</p>
        </div>
      )}
      {q.error && <p className="text-xs text-warning">{q.error}</p>}
      {ev && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Payment evidence</summary>
          <ul className="mt-1 grid gap-0.5">
            <li>
              Paid API response: HTTP {ev.http_status ?? "—"}
              {ev.api_ms !== null ? ` in ${ev.api_ms} ms` : ""}
              {ev.request_id ? ` · request ${shortHash(ev.request_id, 8)}` : ""}
            </li>
            <li>
              Payment signed: {ev.signed ? "yes" : "no"} · payment-response header:{" "}
              {ev.payment_response_present ? "present" : "absent"}
            </li>
            {ev.payment_response?.["provider_reference"] && (
              <li>
                Provider reference:{" "}
                {shortHash(String(ev.payment_response["provider_reference"]), 10)}
              </li>
            )}
            <li>
              Gateway available balance: {usdc(ev.gateway_available_before)} →{" "}
              {usdc(ev.gateway_available_after)} (observed deduction{" "}
              {usdc(ev.gateway_deduction_atomic)})
            </li>
            {ev.response_sha256 && <li>Response SHA-256: {shortHash(ev.response_sha256, 12)}</li>}
            <li>
              Circle Gateway settles nanopayments in batches; no per-request on-chain transaction is
              claimed here.
            </li>
          </ul>
        </details>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tnum mt-0.5 text-base font-semibold">{value}</dd>
    </div>
  );
}

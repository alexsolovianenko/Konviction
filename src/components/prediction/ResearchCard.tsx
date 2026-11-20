import { austinDateTime, shortHash } from "../../lib/format";
import {
  TIMEFRAME_LABEL,
  type ResearchQuote,
  type ResearchReport,
  type ResearchView,
} from "../../quicknodeResearch";

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
const dollars = (n: number | null | undefined, sign = false) =>
  n === null || n === undefined
    ? "—"
    : `${sign && n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 })}`;
const span = (secs: number) =>
  secs >= 3600
    ? `${Math.round((secs / 3600) * 10) / 10} h`
    : secs >= 60
      ? `${Math.round((secs / 60) * 10) / 10} min`
      : `${secs} s`;
const COMPLETENESS: Record<ResearchReport["completeness"], string> = {
  complete: "Complete window",
  partial: "Partial window",
  unavailable: "Unavailable",
};

export function ResearchCard({
  research,
  onRequestQuote,
}: {
  research: ResearchView;
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
            Get DEX buy/sell volume price
            {q.timeframe ? ` (${TIMEFRAME_LABEL[q.timeframe]})` : ""}
          </button>
        </div>
      )}
      {q?.status === "quoted" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p>Confirm the quoted price on your voice call to purchase this research.</p>
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
            [
              q.status === "quoted" ? "Estimated cost" : "Price",
              q.status === "quoted" && q.calls_planned
                ? `up to ${q.calls_planned} calls × ${q.per_call_usdc ?? "—"} = ${q.max_price_usdc ?? q.price_usdc} USDC`
                : `${q.price_usdc} USDC${q.evidence?.calls_signed !== undefined ? ` · ${q.evidence.calls_signed} paid calls` : ""}`,
            ],
            ["Payment", STATUS_TEXT[q.status]],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 break-words text-xs">{v}</dd>
          </div>
        ))}
      </dl>
      {r && <DexVolume r={r} />}
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
            {ev.calls_sent !== undefined && (
              <li>
                Data calls: {ev.calls_sent} sent · {ev.calls_ok ?? 0} HTTP 200 responses ·{" "}
                {ev.calls_signed ?? 0} payments created
              </li>
            )}
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

function DexVolume({ r }: { r: ResearchReport }) {
  return (
    <div className="grid gap-2" aria-label="DEX buy and sell volume">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label={`${r.asset} bought (USD)`} value={dollars(r.buy_usd)} />
        <Metric label={`${r.asset} sold (USD)`} value={dollars(r.sell_usd)} />
        <Metric label="Net buy volume" value={dollars(r.net_buy_usd, true)} />
        <Metric label="Buy share of volume" value={num(r.buy_pct, "%")} />
      </dl>
      <p className="text-xs">{r.headline}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        {(
          [
            [
              "Measured",
              r.measured_from && r.measured_to
                ? `${COMPLETENESS[r.completeness]} · ${span(r.measured_seconds)} of ${TIMEFRAME_LABEL[r.timeframe]} (${austinDateTime(r.measured_from)} – ${austinDateTime(r.measured_to)})`
                : COMPLETENESS[r.completeness],
            ],
            [
              "Trades",
              r.trade_count === null
                ? "—"
                : `${r.trade_count} swaps${r.pool_tx_count !== null ? ` · ${r.pool_tx_count} pool transactions` : ""}`,
            ],
            ["Last trade", r.last_trade_at ? austinDateTime(r.last_trade_at) : "—"],
            ["Source", `${r.source} · ${r.method}`],
            ["Pools", r.pools.map((p) => `${p.dex} ${p.pair}`).join(", ")],
            ["Paid calls used", String(r.calls_used)],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {r.examples.length > 0 && (
        <ul aria-label="Example transactions" className="grid gap-0.5 text-xs">
          {r.examples.map((x) => (
            <li key={x.hash} className="tnum">
              {x.side === "buy" ? "Buy" : "Sell"} {dollars(x.usd)} ·{" "}
              <a href={x.url} target="_blank" rel="noreferrer" className="underline">
                {shortHash(x.hash, 10)}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{r.coverage}</p>
      {r.warnings.length > 0 && <p className="text-xs text-warning">{r.warnings.join(" ")}</p>}
      <p className="text-xs">{r.disclaimer}</p>
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

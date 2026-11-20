import { ArrowUpRight } from "lucide-react";
import { cents, shortHash } from "../../lib/format";
import type { ResearchQuote, ResearchRow, ResearchView } from "../../research";

const MATCH: Record<ResearchRow["match"], string> = {
  same_strike_same_expiry: "Same strike & expiry",
  nearby_strike: "Nearby strike",
  different_expiry: "Different expiry",
  different_structure: "Different contract type",
};
const STEPS: [string, string][] = [
  ["quoted", "Quoted"],
  ["signing", "Paying"],
  ["paid", "Data received"],
  ["settled_onchain", "Settled on Arc"],
];
const ORDER = ["quoted", "signing", "paid", "settled_onchain"];
const STATUS_TEXT: Record<string, string> = {
  unknown_after_sign: "Payment may have gone through. Checking Arc…",
  failed: "Failed. Nothing was paid.",
  expired: "Quote expired. Nothing was paid.",
  free_no_match: "No comparable markets. No charge.",
};

export function ResearchCard({
  research,
  onApprove,
}: {
  research: ResearchView;
  onApprove: () => void;
}) {
  const q = research.quote;
  return (
    <section
      aria-label="Cross-venue research"
      className="min-w-0 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <p className="font-semibold">Second opinion from other markets</p>
        {q && (
          <span className="font-mono text-xs text-muted-foreground">
            {q.network === "eip155:5042" ? "Arc mainnet" : q.network} · USDC
          </span>
        )}
      </div>
      {q && <Details q={q} />}
      {q?.status === "quoted" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="btn"
            disabled={!research.canApprove || research.busy}
            onClick={onApprove}
          >
            Approve research, max {q.price_usd}
          </button>
          <span className="text-xs text-muted-foreground">
            Paid from the research wallet, not your trading balance.
          </span>
        </div>
      )}
      {research.message && (
        <p role="status" className="mt-3 text-sm">
          {research.message}
        </p>
      )}
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        Research is not your trading instruction. Orders need separate approval.
      </p>
    </section>
  );
}

function Details({ q }: { q: ResearchQuote }) {
  const at = ORDER.indexOf(q.status);
  return (
    <div className="mt-3 space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {(
          [
            ["Gemini market", `${q.gemini.title} · ${q.gemini.contractLabel}`],
            ["Provider", q.provider],
            ["Endpoint", `${q.endpoint}?q=${q.query}`],
            ["Price", q.price_usd],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 truncate font-mono text-xs">{v}</dd>
          </div>
        ))}
      </dl>
      <ol aria-label="Payment status" className="flex flex-wrap gap-2 text-xs">
        {STEPS.map(([key, label], i) => (
          <li
            key={key}
            className={
              "rounded border px-2 py-0.5 " +
              (at >= i ? "border-primary text-foreground" : "border-border text-muted-foreground")
            }
          >
            {label}
          </li>
        ))}
      </ol>
      {STATUS_TEXT[q.status] && <p className="text-sm text-warning">{STATUS_TEXT[q.status]}</p>}
      {q.error && q.status !== "failed" && <p className="text-xs text-warning">{q.error}</p>}
      {q.tx_hash && (
        <p className="text-xs">
          Arc transaction{" "}
          {q.explorer_url ? (
            <a
              className="inline-flex items-center gap-1 font-mono text-accent-foreground hover:underline"
              href={q.explorer_url}
              target="_blank"
              rel="noreferrer"
            >
              {shortHash(q.tx_hash, 10)} <ArrowUpRight className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="font-mono">{shortHash(q.tx_hash, 10)}</span>
          )}
          {q.status === "settled_onchain" ? " · USDC transfer verified" : " · verifying"}
        </p>
      )}
      {q.comparison && <Comparison q={q} />}
    </div>
  );
}

function Comparison({ q }: { q: ResearchQuote }) {
  const c = q.comparison!;
  if (!c.rows.length)
    return <p className="text-sm">No comparable markets found ({c.markets_found} returned).</p>;
  return (
    <div className="space-y-2">
      <p>{c.summary}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Venue</th>
              <th className="pr-3">Contract</th>
              <th className="pr-3">YES ask</th>
              <th className="pr-3">Volume</th>
              <th className="pr-3">Match</th>
              <th>Differences</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border">
              <td className="py-1 pr-3">Gemini</td>
              <td className="pr-3">{q.gemini.contractLabel}</td>
              <td className="pr-3 font-mono">
                {q.gemini.yesAsk !== null ? cents(q.gemini.yesAsk) : "—"}
              </td>
              <td className="pr-3">—</td>
              <td className="pr-3">Your market</td>
              <td>
                Settles to {q.gemini.settlement ?? "Gemini index"}; est. fee{" "}
                {q.gemini.feePerContractEst !== null ? cents(q.gemini.feePerContractEst) : "—"}
                /contract
              </td>
            </tr>
            {c.rows.map((r) => (
              <tr key={r.market.venue + r.market.id} className="border-t border-border align-top">
                <td className="py-1 pr-3 capitalize">{r.market.venue}</td>
                <td className="pr-3">{r.market.title}</td>
                <td className="pr-3 font-mono">
                  {r.market.yesAsk !== null ? cents(r.market.yesAsk) : "—"}
                </td>
                <td className="pr-3 font-mono">
                  {r.market.volume !== null
                    ? Math.round(r.market.volume).toLocaleString("en-US")
                    : "—"}
                </td>
                <td className="pr-3">{MATCH[r.match]}</td>
                <td>{r.differences.join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Other venues' prices are what other traders pay under their own rules, not a forecast and
        not Gemini's fair price.
      </p>
    </div>
  );
}

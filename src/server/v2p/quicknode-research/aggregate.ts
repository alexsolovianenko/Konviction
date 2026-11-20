// Turn one paid QuickNode JSON-RPC result into a chain-activity report. Pure functions.
// Reports describe on-chain network activity only; they never predict price direction.

export type Metric = { label: string; value: number | null; unit: string };
export type Comparison = {
  label: string;
  unit: string;
  recent: number;
  previous: number;
  recent_window: string;
  previous_window: string;
  change_pct: number | null;
  direction: "higher" | "lower" | "flat" | "unknown";
};
export type ResearchReport = {
  family: Family;
  chain: string;
  method: string;
  metrics: Metric[];
  comparison: Comparison | null;
  coverage: string | null;
  headline: string;
  observed_at: string;
  warnings: string[];
  disclaimer: string;
};
export type Family = "solana" | "evm" | "utxo" | "xrpl";

export const disclaimerFor = (chain: string) =>
  `${chain} network activity from QuickNode. It is not a price, does not predict price direction, and is not trading advice.`;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (recent: number, previous: number) =>
  previous > 0 ? round2(((recent - previous) / previous) * 100) : null;
const dir = (c: number | null): Comparison["direction"] =>
  c === null ? "unknown" : Math.abs(c) < 0.5 ? "flat" : c > 0 ? "higher" : "lower";
const base = (family: Family, chain: string, method: string, at: Date) => ({
  family,
  chain,
  method,
  observed_at: at.toISOString(),
  disclaimer: disclaimerFor(chain),
  warnings: [] as string[],
});
const compareHeadline = (chain: string, c: Comparison | null, what: string) =>
  c && c.change_pct !== null
    ? `${chain} ${what} over the ${c.recent_window} was ${c.recent} ${c.unit}, ${c.direction === "flat" ? "about flat" : `${Math.abs(c.change_pct).toFixed(1)}% ${c.direction}`} than the ${c.previous_window} (${c.previous}). That is network activity, not a price signal.`
    : `QuickNode returned too little ${chain} data to compare windows.`;

// ---------------------------------------------------------------- Solana: getRecentPerformanceSamples
type Sample = { slot: number; numTransactions: number; nonVote: number | null; period: number };

export function solanaReport(result: unknown, at: Date, chain = "Solana"): ResearchReport {
  const r = base("solana", chain, "getRecentPerformanceSamples(120)", at);
  if (!Array.isArray(result)) r.warnings.push("Provider returned no sample list.");
  const rows = Array.isArray(result) ? result : [];
  const parsed: Sample[] = [];
  for (const raw of rows) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const n = s["numTransactions"],
      p = s["samplePeriodSecs"],
      nv = s["numNonVoteTransactions"];
    if (!finite(s["slot"]) || !finite(n) || n < 0 || !finite(p) || p <= 0) continue;
    parsed.push({
      slot: s["slot"],
      numTransactions: n,
      nonVote: finite(nv) && nv >= 0 && nv <= n ? nv : null,
      period: p,
    });
  }
  if (parsed.length < rows.length)
    r.warnings.push(`${rows.length - parsed.length} malformed samples ignored.`);
  const seen = new Set<number>();
  const sorted = parsed
    .sort((a, b) => b.slot - a.slot)
    .filter((s) => (seen.has(s.slot) ? false : (seen.add(s.slot), true)));
  if (sorted.length < parsed.length) r.warnings.push("Duplicate slots ignored.");
  const usable = sorted.filter((s) => s.nonVote !== null);
  if (usable.length < sorted.length)
    r.warnings.push(
      `${sorted.length - usable.length} samples lacked non-vote counts and were excluded.`,
    );
  const recentS = usable.slice(0, Math.min(Math.ceil(usable.length / 2), 60));
  const prevS = usable.slice(recentS.length, recentS.length + 60);
  const rate = (s: Sample[]) =>
    round2(s.reduce((a, x) => a + (x.nonVote ?? 0), 0) / s.reduce((a, x) => a + x.period, 0));
  const secs = (s: Sample[]) => s.reduce((a, x) => a + x.period, 0);
  let comparison: Comparison | null = null;
  if (recentS.length >= 5 && prevS.length >= 5) {
    const recent = rate(recentS),
      previous = rate(prevS),
      change = pct(recent, previous);
    if (change === null)
      r.warnings.push("Previous window had zero non-vote activity; percent change undefined.");
    comparison = {
      label: "Non-vote transactions per second (period-weighted)",
      unit: "TPS",
      recent,
      previous,
      recent_window: `latest ~${Math.round(secs(recentS) / 60)} min`,
      previous_window: `previous ~${Math.round(secs(prevS) / 60)} min`,
      change_pct: change,
      direction: dir(change),
    };
  } else r.warnings.push("Not enough samples to compare two windows.");
  const coverage = secs(recentS) + secs(prevS);
  return {
    ...r,
    comparison,
    metrics: [{ label: "Usable samples", value: usable.length, unit: `of ${rows.length}` }],
    coverage:
      coverage > 0
        ? `${Math.round(coverage / 60)} minutes of samples (no per-sample timestamps)`
        : null,
    headline: compareHeadline(chain, comparison, "non-vote activity"),
  };
}

// ---------------------------------------------------------------- EVM: eth_feeHistory(120)
export function evmReport(result: unknown, at: Date, chain: string): ResearchReport {
  const r = base("evm", chain, "eth_feeHistory(120 blocks)", at);
  const o = (result ?? {}) as Record<string, unknown>;
  const ratios = Array.isArray(o["gasUsedRatio"]) ? (o["gasUsedRatio"] as unknown[]) : [];
  const fees = Array.isArray(o["baseFeePerGas"]) ? (o["baseFeePerGas"] as unknown[]) : [];
  const util = ratios.map((x) => (finite(x) && x >= 0 && x <= 1.5 ? x : null));
  // baseFeePerGas has one extra (next-block) entry; align with the blocks it priced.
  const gwei = fees.slice(0, ratios.length).map((x) => {
    try {
      return typeof x === "string" && /^0x[0-9a-f]+$/i.test(x) ? Number(BigInt(x)) / 1e9 : null;
    } catch {
      return null;
    }
  });
  const bad = util.filter((x) => x === null).length;
  if (bad) r.warnings.push(`${bad} blocks with malformed utilization ignored.`);
  // Oldest block first in the response; newest are at the end.
  const half = Math.floor(ratios.length / 2);
  const avg = (a: Array<number | null>) => {
    const v = a.filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  let comparison: Comparison | null = null;
  const uPrev = avg(util.slice(0, half)),
    uRecent = avg(util.slice(half));
  if (half >= 5 && uPrev !== null && uRecent !== null) {
    const recent = round2(uRecent * 100),
      previous = round2(uPrev * 100),
      change = pct(recent, previous);
    comparison = {
      label: "Average block gas utilization",
      unit: "%",
      recent,
      previous,
      recent_window: `latest ${ratios.length - half} blocks`,
      previous_window: `previous ${half} blocks`,
      change_pct: change,
      direction: dir(change),
    };
  } else r.warnings.push("Not enough blocks to compare two windows.");
  const fRecent = avg(gwei.slice(half)),
    fPrev = avg(gwei.slice(0, half));
  const oldest =
    typeof o["oldestBlock"] === "string" && /^0x[0-9a-f]+$/i.test(o["oldestBlock"])
      ? Number(BigInt(o["oldestBlock"]))
      : null;
  return {
    ...r,
    comparison,
    metrics: [
      {
        label: "Avg base fee, recent blocks",
        value: fRecent === null ? null : round2(fRecent * 1000) / 1000,
        unit: "gwei",
      },
      {
        label: "Avg base fee, previous blocks",
        value: fPrev === null ? null : round2(fPrev * 1000) / 1000,
        unit: "gwei",
      },
      { label: "Blocks", value: ratios.length, unit: oldest !== null ? `from #${oldest}` : "" },
    ],
    coverage: ratios.length ? `${ratios.length} blocks` : null,
    headline: compareHeadline(chain, comparison, "block gas utilization"),
  };
}

// ---------------------------------------------------------------- UTXO chains: getmempoolinfo
export function utxoReport(result: unknown, at: Date, chain: string): ResearchReport {
  const r = base("utxo", chain, "getmempoolinfo", at);
  const o = (result ?? {}) as Record<string, unknown>;
  const size = finite(o["size"]) && o["size"] >= 0 ? o["size"] : null;
  const bytes = finite(o["bytes"]) && o["bytes"] >= 0 ? o["bytes"] : null;
  const minFee = finite(o["mempoolminfee"]) && o["mempoolminfee"] >= 0 ? o["mempoolminfee"] : null;
  const totalFee = finite(o["total_fee"]) && o["total_fee"] >= 0 ? o["total_fee"] : null;
  if (size === null) r.warnings.push("Provider returned no mempool size.");
  r.warnings.push("Single snapshot: no earlier window to compare.");
  return {
    ...r,
    comparison: null,
    metrics: [
      { label: "Pending transactions", value: size, unit: "tx" },
      { label: "Mempool size", value: bytes === null ? null : round2(bytes / 1e6), unit: "MB" },
      { label: "Minimum mempool fee", value: minFee, unit: `${chain} per kvB` },
      { label: "Total pending fees", value: totalFee, unit: chain },
    ],
    coverage: "Current mempool snapshot",
    headline:
      size === null
        ? `QuickNode returned no ${chain} mempool data.`
        : `${chain} mempool currently holds ${size.toLocaleString("en-US")} pending transactions${bytes === null ? "" : ` (${round2(bytes / 1e6)} MB)`}. That is network congestion, not a price signal.`,
  };
}

// ---------------------------------------------------------------- XRP Ledger: fee
export function xrplReport(result: unknown, at: Date, chain: string): ResearchReport {
  const r = base("xrpl", chain, "fee", at);
  const o = (result ?? {}) as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : finite(v) ? v : null;
  const drops = (o["drops"] ?? {}) as Record<string, unknown>;
  const queue = num(o["current_queue_size"]),
    ledger = num(o["current_ledger_size"]),
    expected = num(o["expected_ledger_size"]);
  const fill = ledger !== null && expected ? round2((ledger / expected) * 100) : null;
  if (ledger === null) r.warnings.push("Provider returned no open-ledger size.");
  r.warnings.push("Single snapshot: no earlier window to compare.");
  return {
    ...r,
    comparison: null,
    metrics: [
      { label: "Transactions in open ledger", value: ledger, unit: "tx" },
      { label: "Open ledger vs expected size", value: fill, unit: "%" },
      { label: "Queued transactions", value: queue, unit: "tx" },
      { label: "Open-ledger fee", value: num(drops["open_ledger_fee"]), unit: "drops" },
      { label: "Median fee", value: num(drops["median_fee"]), unit: "drops" },
    ],
    coverage: "Current open ledger snapshot",
    headline:
      ledger === null
        ? `QuickNode returned no ${chain} fee data.`
        : `The current ${chain} open ledger has ${ledger} transactions${fill === null ? "" : `, ${fill}% of the expected size`}, with ${queue ?? "unknown"} queued. That is network load, not a price signal.`,
  };
}

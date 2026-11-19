import { Dashboard } from "@/pages/Dashboard";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { cents, countdown, hms, num, sha256Hex, shortHash, usd } from "@/lib/format";
import type { DashboardState, Intent, Order, Receipt } from "./types";

const URL_ = "/api/public/dashboard-state";


async function fetchState(): Promise<DashboardState> {
  const r = await fetch(URL_, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || typeof j !== "object" || !("activity" in j)) throw new Error("Unexpected response");
  return j as DashboardState;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type Tone = "success" | "warning" | "danger" | "muted" | "violet" | "info" | "primary";
const toneCls: Record<Tone, string> = {
  success: "border-success/40 bg-success/15 text-success",
  warning: "border-warning/40 bg-warning/15 text-warning",
  danger: "border-destructive/50 bg-destructive/15 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
  violet: "border-violet/40 bg-violet/15 text-violet",
  info: "border-info/40 bg-info/15 text-info",
  primary: "border-primary/40 bg-primary/10 text-primary",
};

function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide", toneCls[tone], className)}>
      {children}
    </span>
  );
}

function kindTone(kind: string): Tone {
  switch (kind) {
    case "ORDER_FILLED": return "success";
    case "ORDER_PARTIAL": case "PRICE_MOVED": return "warning";
    case "ORDER_NOT_FILLED": return "muted";
    case "ORDER_PENDING_UNKNOWN": return "violet";
    case "ORDER_EXCHANGE_REJECTED": case "PIN_FAILED": return "danger";
    case "CALL_STARTED": return "info";
    case "INTENT_PROPOSED": case "ORDER_SENT": return "primary";
    default: return "muted";
  }
}

function summaryTone(s: string | null): Tone {
  const k = (s ?? "").toUpperCase().replace(/[_\s]+/g, " ");
  if (k.includes("NOT FILLED")) return "muted";
  if (k.includes("FILLED")) return "success";
  if (k.includes("PARTIAL")) return "warning";
  if (k.includes("PENDING")) return "violet";
  if (k.includes("REJECT")) return "danger";
  return "muted";
}

function Panel({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel flex min-w-0 flex-col", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Btn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-sm border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary">
      {children}
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

type DrawerState = { title: string; body: ReactNode } | null;

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => (typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)), [value]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <button
        onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="rounded-sm border border-primary/50 px-2 py-1 font-mono text-xs text-primary hover:bg-primary/10"
      >{copied ? "Copied ✓" : "Copy"}</button>
      <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-all rounded-sm bg-background p-3 font-mono text-xs leading-relaxed">{text}</pre>
    </div>
  );
}

function VerifyReceipt({ r }: { r: Receipt }) {
  const [result, setResult] = useState<{ hash: string; ok: boolean } | null>(null);
  return (
    <div className="space-y-4 font-mono text-xs">
      <div><div className="text-muted-foreground">Stored sha256</div><div className="break-all">{r.sha256}</div></div>
      <button
        onClick={async () => { const h = await sha256Hex(r.payload_text); setResult({ hash: h, ok: h.toLowerCase() === r.sha256.toLowerCase() }); }}
        className="rounded-sm bg-primary px-3 py-1.5 font-sans text-sm font-semibold text-primary-foreground hover:opacity-90"
      >Recompute SHA-256 in browser</button>
      {result && (
        <div className="space-y-1">
          <div className="text-muted-foreground">Computed</div>
          <div className="break-all">{result.hash}</div>
          <Pill tone={result.ok ? "success" : "danger"} className="text-sm">{result.ok ? "✓ match" : "✗ mismatch"}</Pill>
        </div>
      )}
      <div><div className="mb-1 text-muted-foreground">payload_text</div><JsonBlock value={r.payload_text} /></div>
    </div>
  );
}

export function Console() {
  const now = useNow();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const q = useQuery({ queryKey: ["dashboard-state"], queryFn: fetchState, refetchInterval: 2500, retry: false, refetchIntervalInBackground: true });
  const d = q.data;
  const ageS = q.dataUpdatedAt ? Math.max(0, Math.floor((now - q.dataUpdatedAt) / 1000)) : null;
  const open = (title: string, body: ReactNode) => setDrawer({ title, body });

  return (
    <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-4 p-3 sm:p-5">
      <Header d={d} ageS={ageS} />
      <Dashboard />
      {d?.history_available === false && <p className="text-muted-foreground">Private account history unavailable.</p>}
      {!d ? (
        <div className="panel flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <span className="h-3 w-3 animate-pulse rounded-full bg-primary" />
          <p className="text-lg font-medium">Waiting for backend…</p>
          <p className="font-mono text-xs text-muted-foreground">
            {q.isError ? `dashboard-state unavailable (${(q.error as Error).message}) · retrying every 2.5s` : "connecting"}
          </p>
        </div>
      ) : (
        <>
          <AccountStrip d={d} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Timeline d={d} open={open} />
            <Trades d={d} now={now} open={open} />
          </div>
          {d.markets && <Markets markets={d.markets} />}
          <Positions d={d} open={open} />
          <Receipts d={d} open={open} />
        </>
      )}
      <footer className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        Sandbox only — test money, sandbox prices are not real market prices. The agent only speaks numbers returned by Gemini. Receipts prove what we recorded and when; Gemini's API is the source of truth for execution. No recommendations.
      </footer>
      <Sheet open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader><SheetTitle className="font-mono text-sm">{drawer?.title}</SheetTitle></SheetHeader>
          <div className="px-4 pb-6">{drawer?.body}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Header({ d, ageS }: { d: DashboardState | undefined; ageS: number | null }) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Voice-to-<span className="text-primary">Predict</span></h1>
        <p className="text-sm text-muted-foreground">Explore sandbox prediction markets by voice.</p>
      </div>
      {d?.phone_number && (
        <a href={`tel:${d.phone_number}`} className="font-mono text-3xl font-bold tracking-tight text-primary hover:underline sm:text-5xl">
          {d.phone_number}
        </a>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="warning">Gemini sandbox · test funds</Pill>
        {d && <Pill tone={d.execution_enabled ? "success" : "danger"}>Execution {d.execution_enabled ? "ON" : "OFF"}</Pill>}
        <Pill tone={ageS === null || ageS > 10 ? "danger" : "muted"}>
          {ageS === null ? "No update yet" : `Last update ${ageS}s ago`}
        </Pill>
      </div>
    </header>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xl font-semibold">{value}</div>
      {sub && <div className="truncate font-mono text-[11px] text-destructive">{sub}</div>}
    </div>
  );
}

function AccountStrip({ d }: { d: DashboardState }) {
  const a = d.account;
  const l = d.limits;
  const limits = `${usd(l.maxOrderUsd).replace(".00", "")}/order · ${usd(l.maxDailyUsd).replace(".00", "")}/day · max ${cents(l.maxLimitPrice)}`;
  if (!a.configured) {
    return (
      <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="text-warning">Gemini keys not configured yet</span>
        <span className="font-mono text-sm text-muted-foreground">{limits}</span>
      </div>
    );
  }
  return (
    <div className="panel grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x">
      <Stat label="USD available" value={usd(a.usd_available)} sub={a.balance_error} />
      <Stat label="Terms accepted" value={a.terms_accepted === null ? "—" : a.terms_accepted ? <span className="text-success">✓</span> : <span className="text-destructive">✗</span>} sub={a.terms_error} />
      <Stat label="Open positions" value={a.positions?.length ?? 0} sub={a.positions_error} />
      <Stat label="Limits" value={<span className="text-base">{limits}</span>} />
    </div>
  );
}

function Timeline({ d, open }: { d: DashboardState; open: (t: string, b: ReactNode) => void }) {
  return (
    <Panel title="Live call timeline" right={<span className="font-mono text-[11px] text-muted-foreground">{d.activity.length} events</span>}>
      {d.activity.length === 0 ? <Empty>No activity yet. Call the number to start.</Empty> : (
        <ul className="max-h-[640px] divide-y divide-border overflow-y-auto">
          {d.activity.map((e) => (
            <li key={e.id} className="animate-row-in">
              <button
                onClick={() => open(`${e.kind} · ${hms(e.at)}`, <JsonBlock value={{ kind: e.kind, at: e.at, summary: e.summary }} />)}
                className="grid w-full grid-cols-[auto_auto_1fr] items-start gap-x-3 gap-y-1 px-4 py-2 text-left transition-colors hover:bg-muted sm:grid-cols-[72px_auto_110px_1fr]"
              >
                <span className="font-mono text-xs text-muted-foreground">{hms(e.at)}</span>
                <Pill tone={kindTone(e.kind)}>{e.kind}</Pill>
                <span className="truncate font-mono text-xs text-muted-foreground">{e.caller ?? "—"}</span>
                <span className="col-span-3 text-sm sm:col-span-1">{e.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SideOutcome({ side, outcome }: { side: string; outcome: string }) {
  const buy = side.toUpperCase() === "BUY";
  return (
    <div className="flex gap-1">
      <Pill tone={buy ? "primary" : "warning"}>{side.toUpperCase()}</Pill>
      <Pill tone={outcome.toUpperCase() === "YES" ? "success" : "danger"}>{outcome.toUpperCase()}</Pill>
    </div>
  );
}

function Trades({ d, now, open }: { d: DashboardState; now: number; open: (t: string, b: ReactNode) => void }) {
  const byId = new Map(d.intents.map((i) => [i.id, i] as const));
  const pending = d.intents.filter((i) => i.status === "PROPOSED");
  const showReceipts = (o: Order) => {
    const rs = d.receipts.filter((r) => r.intent_id === o.intent_id);
    open(`Receipts · ${o.intent_id}`, rs.length ? <JsonBlock value={rs} /> : <Empty>No receipts for this trade yet.</Empty>);
  };
  return (
    <Panel title="Trades">
      <div className="max-h-[640px] space-y-3 overflow-y-auto p-3">
        {pending.length === 0 && d.orders.length === 0 && <Empty>No trades yet.</Empty>}
        {pending.map((i) => <PendingCard key={i.id} i={i} now={now} />)}
        {d.orders.map((o) => <OrderCard key={o.id} o={o} i={byId.get(o.intent_id)} onRaw={() => open(`Raw Gemini response · ${o.gemini_order_id ?? o.id}`, <JsonBlock value={o} />)} onReceipts={() => showReceipts(o)} />)}
      </div>
    </Panel>
  );
}

function PendingCard({ i, now }: { i: Intent; now: number }) {
  const left = countdown(i.expires_at, now);
  return (
    <div className="animate-row-in rounded-sm border border-dashed border-warning/60 bg-warning/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <SideOutcome side={i.side} outcome={i.outcome} />
        <Pill tone="warning">Awaiting PIN · {left}</Pill>
      </div>
      <div className="text-sm font-medium">{i.contract_label ?? i.instrument_symbol}</div>
      {i.title && <div className="text-xs text-muted-foreground">{i.title}</div>}
      <div className="mt-2 font-mono text-xs">Asked: {i.quantity} @ ≤ {cents(i.limit_price)} <span className="text-muted-foreground">· est. fee {usd(i.est_fee_usd)} · code {i.code}</span></div>
    </div>
  );
}

function OrderCard({ o, i, onRaw, onReceipts }: { o: Order; i: Intent | undefined; onRaw: () => void; onReceipts: () => void }) {
  return (
    <div className="animate-row-in rounded-sm border border-border bg-background/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SideOutcome side={o.side ?? i?.side ?? "?"} outcome={i?.outcome ?? "?"} />
        <Pill tone={summaryTone(o.outcome_summary)}>{(o.outcome_summary ?? o.exchange_status ?? "—").replace(/_/g, " ")}</Pill>
      </div>
      <div className="text-sm font-medium">{i?.contract_label ?? i?.instrument_symbol ?? "Unknown contract"}</div>
      {i?.title && <div className="text-xs text-muted-foreground">{i.title}</div>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
        <dt className="text-muted-foreground">Asked</dt><dd>{i ? `${i.quantity} @ ≤ ${cents(i.limit_price)}` : "—"}</dd>
        <dt className="text-muted-foreground">Gemini filled</dt><dd className="text-primary">{num(o.filled_qty)} @ {cents(o.avg_price)}</dd>
        <dt className="text-muted-foreground">Fee</dt><dd>{usd(i?.est_fee_usd)} est.</dd>
        <dt className="text-muted-foreground">Order id</dt><dd className="break-all">{o.gemini_order_id ?? "—"}</dd>
      </dl>
      {o.error && <div className="mt-2 font-mono text-xs text-destructive">{o.error}</div>}
      <div className="mt-3 flex gap-2"><Btn onClick={onRaw}>Raw Gemini response</Btn><Btn onClick={onReceipts}>Receipts</Btn></div>
    </div>
  );
}

const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
const td = "px-3 py-2 font-mono text-xs whitespace-nowrap";

function Markets({ markets }: { markets: NonNullable<DashboardState["markets"]> }) {
  const rows = markets.events.flatMap((event) => event.contracts.map((contract) => ({ event, contract })));
  return (
    <Panel title="Prediction markets (Gemini Sandbox)">
      {markets.error ? <Empty>Markets unavailable: {markets.error}</Empty> : rows.length === 0 ? (
        <Empty>No active contracts returned by Gemini Sandbox.</Empty>
      ) : (
        <div className="max-h-[480px] overflow-auto" role="region" aria-label="Gemini Sandbox market listings" tabIndex={0}>
          <table className="w-full" aria-label="Gemini Sandbox prediction markets">
            <thead className="sticky top-0 border-b border-border bg-card"><tr>{["Event", "Contract", "YES ask / bid", "NO ask / bid", "Status", "Expiry (UTC)"].map((h) => <th key={h} scope="col" className={cn(th, "whitespace-nowrap")}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ event, contract }) => (
                <tr key={`${event.ticker}-${contract.symbol}`}>
                  <td className="min-w-40 px-3 py-2 text-sm">{event.title}<div className="text-[11px] text-muted-foreground">{[event.category, event.status].filter(Boolean).join(" · ")}</div></td>
                  <td className="min-w-40 px-3 py-2 text-sm">{contract.label ?? contract.symbol}{contract.label && <div className="break-all font-mono text-[11px] text-muted-foreground">{contract.symbol}</div>}</td>
                  <td className={cn(td, "text-success")}>{cents(contract.buy.yes)} / {cents(contract.sell.yes)}</td>
                  <td className={cn(td, "text-destructive")}>{cents(contract.buy.no)} / {cents(contract.sell.no)}</td>
                  <td className={td}>{[contract.status, contract.market_state].filter(Boolean).join(" · ") || "—"}</td>
                  <td className={td}>{contract.expiry?.replace("T", " ").replace(/(?:\.\d+)?Z$/, "") ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Positions({ d, open }: { d: DashboardState; open: (t: string, b: ReactNode) => void }) {
  const ps = d.account.positions ?? [];
  return (
    <Panel title="Positions (from Gemini)" right={<Btn onClick={() => open("Position details", <JsonBlock value={d.account.positions} />)}>Position details</Btn>}>
      {ps.length === 0 ? <Empty>{d.account.positions_error ?? "No open positions."}</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-border"><tr>{["Contract", "Outcome", "Qty", "Avg", "Bid", "Mkt value", "Unreal. P&L", "Status"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {ps.map((p, idx) => (
                <tr key={`${p.symbol}-${p.outcome}-${idx}`}>
                  <td className={cn(td, "font-sans text-sm")}>{p.contract ?? p.symbol}{p.event && <div className="text-[11px] text-muted-foreground">{p.event}</div>}</td>
                  <td className={td}>{p.outcome}</td>
                  <td className={td}>{p.quantity}{p.on_hold ? <span className="text-muted-foreground"> ({p.on_hold} held)</span> : null}</td>
                  <td className={td}>{cents(p.avg_price)}</td>
                  <td className={td}>{cents(p.bid)}</td>
                  <td className={td}>{usd(p.market_value)}</td>
                  <td className={cn(td, p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "text-success" : "text-destructive")}>{usd(p.unrealized_pnl)}</td>
                  <td className={td}>{p.contract_status ?? "—"}{p.resolution_side ? ` · ${p.resolution_side}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Receipts({ d, open }: { d: DashboardState; open: (t: string, b: ReactNode) => void }) {
  const s = d.solana;
  const wallet = s?.address ? (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <a className="text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/address/${s.address}?cluster=devnet`}>{shortHash(s.address, 6)}</a>
      <span className="text-muted-foreground">{s.balance_sol ?? "—"} SOL</span>
      {s.balance_sol === 0 && <a className="text-warning hover:underline" target="_blank" rel="noreferrer" href="https://faucet.solana.com">Fund at faucet.solana.com</a>}
    </div>
  ) : <span className="font-mono text-[11px] text-muted-foreground">No receipt wallet</span>;
  return (
    <Panel title="Onchain receipts (Solana devnet)" right={wallet}>
      {d.receipts.length === 0 ? <Empty>No receipts yet.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-border"><tr>{["Time", "Kind", "sha256", "Status", ""].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {d.receipts.map((r) => (
                <tr key={r.id} className="animate-row-in">
                  <td className={cn(td, "text-muted-foreground")}>{hms(r.created_at)}</td>
                  <td className={td}><Pill tone={r.kind === "approval" ? "info" : "primary"}>{r.kind}</Pill></td>
                  <td className={td}>{shortHash(r.sha256)}</td>
                  <td className={td}>
                    {r.solana_sig ? (
                      <a className="text-success hover:underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${r.solana_sig}?cluster=devnet`}>✓ anchored</a>
                    ) : r.error === "anchoring…" ? <span className="text-muted-foreground">anchoring…</span>
                    : r.error ? <span className="text-destructive">{r.error}</span> : <span className="text-muted-foreground">pending</span>}
                  </td>
                  <td className={td}><Btn onClick={() => open(`Verify receipt · ${r.kind}`, <VerifyReceipt r={r} />)}>Verify</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

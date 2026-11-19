import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, Search } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { cents, countdown, hms, num, sha256Hex, shortHash, usd } from "@/lib/format";
import type { DashboardState, Intent, Order, Receipt } from "./types";
import { Btn, Empty, JsonBlock, PageHeader, Panel, Pill, td, th, type Tone } from "./ui";

const URL_ = "/api/public/dashboard-state";

async function fetchState(): Promise<DashboardState> {
  const r = await fetch(URL_, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || typeof j !== "object" || !("activity" in j)) throw new Error("Unexpected response");
  return j as DashboardState;
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// One shared poll of the read-only dashboard feed; every view renders only what it returns.
export function useDashboardState() {
  return useQuery({ queryKey: ["dashboard-state"], queryFn: fetchState, refetchInterval: 2500, retry: false, refetchIntervalInBackground: true });
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

function VerifyReceipt({ r }: { r: Receipt }) {
  const [result, setResult] = useState<{ hash: string; ok: boolean } | null>(null);
  return (
    <div className="space-y-4 text-sm">
      <div><div className="text-muted-foreground">Stored sha256</div><div className="break-all font-mono text-xs">{r.sha256}</div></div>
      <button
        onClick={async () => { const h = await sha256Hex(r.payload_text); setResult({ hash: h, ok: h.toLowerCase() === r.sha256.toLowerCase() }); }}
        className="btn btn-primary"
      >Recompute SHA-256 in browser</button>
      {result && (
        <div className="space-y-1">
          <div className="text-muted-foreground">Computed</div>
          <div className="break-all font-mono text-xs">{result.hash}</div>
          <Pill tone={result.ok ? "success" : "danger"} className="text-sm">{result.ok ? "✓ match" : "✗ mismatch"}</Pill>
        </div>
      )}
      <div><div className="mb-1 text-muted-foreground">payload_text</div><JsonBlock value={r.payload_text} /></div>
    </div>
  );
}

type Open = (title: string, body: ReactNode) => void;

function Waiting({ q }: { q: ReturnType<typeof useDashboardState> }) {
  return (
    <div className="stage flex flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <span className="spinner spinner-ink" aria-hidden />
      <p className="display text-3xl">Waiting for backend…</p>
      <p className="tnum text-sm text-muted-foreground">
        {q.isError ? `dashboard-state unavailable (${(q.error as Error).message}) · retrying every 2.5s` : "connecting"}
      </p>
    </div>
  );
}

function useDrawer() {
  const [drawer, setDrawer] = useState<{ title: string; body: ReactNode } | null>(null);
  const open: Open = (title, body) => setDrawer({ title, body });
  const sheet = (
    <Sheet open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader><SheetTitle className="break-all text-base">{drawer?.title}</SheetTitle></SheetHeader>
        <div className="px-4 pb-6">{drawer?.body}</div>
      </SheetContent>
    </Sheet>
  );
  return { open, sheet };
}

const Disclaimer = () => (
  <footer className="pt-2 text-xs leading-relaxed text-muted-foreground">
    Sandbox only — test money, sandbox prices are not real market prices. The agent only speaks numbers returned by Gemini. Receipts prove what we recorded and when; Gemini's API is the source of truth for execution. No recommendations.
  </footer>
);

export function OverviewView() {
  const now = useNow();
  const q = useDashboardState();
  const d = q.data;
  const { open, sheet } = useDrawer();
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="Dashboard"
        lead="Read-only view of the Gemini Sandbox account, voice activity, trades and receipts."
        right={d?.phone_number && (
          <a href={`tel:${d.phone_number}`} className="btn btn-ink btn-lg tnum">
            <Phone className="size-4" aria-hidden /> {d.phone_number}
          </a>
        )}
      />
      {d?.history_available === false && <p className="rounded-xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">Private account history unavailable.</p>}
      {!d ? <Waiting q={q} /> : (
        <>
          <AccountStrip d={d} />
          <div className="grid items-start gap-6 lg:gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Trades d={d} now={now} open={open} />
            <Timeline d={d} open={open} />
          </div>
          <Positions d={d} open={open} />
          <Receipts d={d} open={open} />
        </>
      )}
      <Disclaimer />
      {sheet}
    </div>
  );
}

export function MarketsView() {
  const q = useDashboardState();
  const d = q.data;
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader title="Markets" lead="Active prediction contracts from the Gemini Sandbox feed, refreshed while this page is open." />
      {!d ? <Waiting q={q} /> : d.markets ? <Markets markets={d.markets} /> : (
        <div className="panel"><Empty>Market listings are not included in the current dashboard feed.</Empty></div>
      )}
      <Disclaimer />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <div className="text-[0.95rem] font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-destructive">{sub}</div>}
      </div>
      <div className="tnum text-right text-[0.95rem] font-semibold">{value}</div>
    </div>
  );
}

// Balance first, as the one number that matters; account facts sit beside it as a quiet list.
function AccountStrip({ d }: { d: DashboardState }) {
  const a = d.account;
  const l = d.limits;
  const money = (n: number) => usd(n).replace(".00", "");
  return (
    <div className="stage grid gap-6 p-6 sm:p-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-center lg:gap-10 lg:p-12">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-muted-foreground">USD available · Gemini Sandbox</div>
        {a.configured ? (
          <div className="display tnum mt-2 truncate text-6xl sm:text-7xl lg:text-[5.5rem]">{usd(a.usd_available)}</div>
        ) : (
          <div className="display mt-2 text-4xl text-warning sm:text-5xl">Gemini keys not configured yet</div>
        )}
        {a.balance_error && <div className="mt-2 text-sm text-destructive">{a.balance_error}</div>}
      </div>
      <div className="divide-y divide-border rounded-3xl bg-background px-5 py-1.5 sm:px-6">
        {a.configured && (
          <>
            <Stat label="Open positions" value={a.positions?.length ?? 0} sub={a.positions_error} />
            <Stat label="Terms accepted" value={a.terms_accepted === null ? "—" : a.terms_accepted ? <span className="text-success">Yes</span> : <span className="text-destructive">No</span>} sub={a.terms_error} />
          </>
        )}
        <Stat label="Order limit" value={`${money(l.maxOrderUsd)} per order`} />
        <Stat label="Daily limit" value={`${money(l.maxDailyUsd)} per day`} />
        <Stat label="Highest limit price" value={cents(l.maxLimitPrice)} />
      </div>
    </div>
  );
}

function Timeline({ d, open }: { d: DashboardState; open: Open }) {
  return (
    <Panel title="Voice activity" right={<span className="tnum text-sm text-muted-foreground">{d.activity.length} events</span>}>
      {d.activity.length === 0 ? <Empty>No activity yet. Call the number to start.</Empty> : (
        <ul className="max-h-[40rem] overflow-y-auto px-2 pb-2">
          {d.activity.map((e) => (
            <li key={e.id} className="animate-row-in">
              <button
                onClick={() => open(`${e.kind} · ${hms(e.at)}`, <JsonBlock value={{ kind: e.kind, at: e.at, summary: e.summary }} />)}
                className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-muted sm:px-5"
              >
                <Pill tone={kindTone(e.kind)}>{e.kind.replace(/_/g, " ")}</Pill>
                <span className="tnum truncate text-xs text-muted-foreground">{e.caller ?? "—"}</span>
                <span className="tnum text-xs text-muted-foreground">{hms(e.at)}</span>
                <span className="col-span-3 text-[0.95rem]">{e.summary}</span>
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

function Trades({ d, now, open }: { d: DashboardState; now: number; open: Open }) {
  const byId = new Map(d.intents.map((i) => [i.id, i] as const));
  const pending = d.intents.filter((i) => i.status === "PROPOSED");
  const showReceipts = (o: Order) => {
    const rs = d.receipts.filter((r) => r.intent_id === o.intent_id);
    open(`Receipts · ${o.intent_id}`, rs.length ? <JsonBlock value={rs} /> : <Empty>No receipts for this trade yet.</Empty>);
  };
  return (
    <Panel title="Trades">
      <div className="max-h-[40rem] space-y-3 overflow-y-auto px-5 pb-6 sm:px-7">
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
    <div className="animate-row-in rounded-3xl bg-warning/10 p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SideOutcome side={i.side} outcome={i.outcome} />
        <Pill tone="warning">Awaiting PIN · {left}</Pill>
      </div>
      <div className="text-xl font-semibold tracking-tight">{i.contract_label ?? i.instrument_symbol}</div>
      {i.title && <div className="text-sm text-muted-foreground">{i.title}</div>}
      <div className="tnum mt-2 text-sm">Asked: {i.quantity} @ ≤ {cents(i.limit_price)} <span className="text-muted-foreground">· est. fee {usd(i.est_fee_usd)} · code {i.code}</span></div>
    </div>
  );
}

function OrderCard({ o, i, onRaw, onReceipts }: { o: Order; i: Intent | undefined; onRaw: () => void; onReceipts: () => void }) {
  return (
    <div className="animate-row-in rounded-3xl bg-muted p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SideOutcome side={o.side ?? i?.side ?? "?"} outcome={i?.outcome ?? "?"} />
        <Pill tone={summaryTone(o.outcome_summary)}>{(o.outcome_summary ?? o.exchange_status ?? "—").replace(/_/g, " ")}</Pill>
      </div>
      <div className="text-xl font-semibold tracking-tight">{i?.contract_label ?? i?.instrument_symbol ?? "Unknown contract"}</div>
      {i?.title && <div className="text-sm text-muted-foreground">{i.title}</div>}
      <dl className="tnum mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Asked</dt><dd>{i ? `${i.quantity} @ ≤ ${cents(i.limit_price)}` : "—"}</dd>
        <dt className="text-muted-foreground">Gemini filled</dt><dd className="font-semibold text-primary">{num(o.filled_qty)} @ {cents(o.avg_price)}</dd>
        <dt className="text-muted-foreground">Fee</dt><dd>{usd(i?.est_fee_usd)} est.</dd>
        <dt className="text-muted-foreground">Order id</dt><dd className="break-all">{o.gemini_order_id ?? "—"}</dd>
      </dl>
      {o.error && <div className="mt-2 break-words text-sm text-destructive">{o.error}</div>}
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn btn-chip bg-background" onClick={onRaw}>Raw Gemini response</button><button type="button" className="btn btn-chip bg-background" onClick={onReceipts}>Receipts</button></div>
    </div>
  );
}

function Markets({ markets }: { markets: NonNullable<DashboardState["markets"]> }) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return markets.events
      .flatMap((event) => event.contracts.map((contract) => ({ event, contract })))
      .filter(({ event, contract }) => !needle || [event.title, event.ticker, event.category, contract.label, contract.symbol].some((v) => v?.toLowerCase().includes(needle)));
  }, [markets, filter]);
  const expiry = (v: string | null) => v?.replace("T", " ").replace(/(?:\.\d+)?Z$/, "") ?? "—";
  const state = (c: (typeof rows)[number]["contract"]) => [c.status, c.market_state].filter(Boolean).join(" · ") || "—";
  return (
    <Panel
      title="Prediction markets (Gemini Sandbox)"
      right={
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input className="field h-11 rounded-full border-transparent bg-muted pl-10" aria-label="Filter listed contracts" placeholder="Filter this listing" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      }
    >
      {markets.error ? <Empty>Markets unavailable: {markets.error}</Empty> : rows.length === 0 ? (
        <Empty>{filter.trim() ? "No listed contracts match this filter." : "No active contracts returned by Gemini Sandbox."}</Empty>
      ) : (
        <>
          <ul className="divide-y divide-border md:hidden" aria-label="Gemini Sandbox prediction markets">
            {rows.map(({ event, contract }) => (
              <li key={`${event.ticker}-${contract.symbol}`} className="space-y-2 px-5 py-4">
                <div>
                  <div className="font-semibold leading-snug">{event.title}</div>
                  <div className="text-sm">{contract.label ?? contract.symbol}</div>
                  <div className="break-all font-mono text-[11px] text-muted-foreground">{contract.symbol}</div>
                </div>
                <div className="tnum grid grid-cols-2 gap-2 text-sm font-semibold">
                  <div className="rounded-xl bg-success/10 px-3 py-2 text-success"><span className="block text-xs font-medium opacity-80">YES ask / bid</span>{cents(contract.buy.yes)} / {cents(contract.sell.yes)}</div>
                  <div className="rounded-xl bg-destructive/10 px-3 py-2 text-destructive"><span className="block text-xs font-medium opacity-80">NO ask / bid</span>{cents(contract.buy.no)} / {cents(contract.sell.no)}</div>
                </div>
                <div className="tnum text-xs text-muted-foreground">{state(contract)} · Expires {expiry(contract.expiry)} UTC</div>
              </li>
            ))}
          </ul>
          <div className="hidden max-h-[70vh] overflow-auto md:block" role="region" aria-label="Gemini Sandbox market listings" tabIndex={0}>
            <table className="w-full" aria-label="Gemini Sandbox prediction markets">
              <thead className="sticky top-0 border-y border-border bg-background"><tr>{["Event", "Contract", "YES ask / bid", "NO ask / bid", "Status", "Expiry (UTC)"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ event, contract }) => (
                  <tr key={`${event.ticker}-${contract.symbol}`} className="hover:bg-muted/40">
                    <td className="min-w-44 px-5 py-4 text-[0.95rem] font-semibold sm:px-7">{event.title}<div className="text-xs font-normal text-muted-foreground">{[event.category, event.status].filter(Boolean).join(" · ")}</div></td>
                    <td className="min-w-44 px-5 py-4 text-[0.95rem] sm:px-7">{contract.label ?? contract.symbol}{contract.label && <div className="break-all font-mono text-[11px] text-muted-foreground">{contract.symbol}</div>}</td>
                    <td className={cn(td, "font-semibold text-success")}>{cents(contract.buy.yes)} / {cents(contract.sell.yes)}</td>
                    <td className={cn(td, "font-semibold text-destructive")}>{cents(contract.buy.no)} / {cents(contract.sell.no)}</td>
                    <td className={td}>{state(contract)}</td>
                    <td className={td}>{expiry(contract.expiry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function Positions({ d, open }: { d: DashboardState; open: Open }) {
  const ps = d.account.positions ?? [];
  return (
    <Panel title="Positions (from Gemini)" right={<Btn onClick={() => open("Position details", <JsonBlock value={d.account.positions} />)}>Position details</Btn>}>
      {ps.length === 0 ? <Empty>{d.account.positions_error ?? "No open positions."}</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-y border-border"><tr>{["Contract", "Outcome", "Qty", "Avg", "Bid", "Mkt value", "Unreal. P&L", "Status"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {ps.map((p, idx) => (
                <tr key={`${p.symbol}-${p.outcome}-${idx}`}>
                  <td className={cn(td, "min-w-44 whitespace-normal font-medium")}>{p.contract ?? p.symbol}{p.event && <div className="text-xs font-normal text-muted-foreground">{p.event}</div>}</td>
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

function Receipts({ d, open }: { d: DashboardState; open: Open }) {
  const s = d.solana;
  const wallet = s?.address ? (
    <div className="tnum flex flex-wrap items-center gap-2 text-xs">
      <a className="text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/address/${s.address}?cluster=devnet`}>{shortHash(s.address, 6)}</a>
      <span className="text-muted-foreground">{s.balance_sol ?? "—"} SOL</span>
      {s.balance_sol === 0 && <a className="text-warning hover:underline" target="_blank" rel="noreferrer" href="https://faucet.solana.com">Fund at faucet.solana.com</a>}
    </div>
  ) : <span className="text-xs text-muted-foreground">No receipt wallet</span>;
  return (
    <Panel title="Onchain receipts (Solana devnet)" right={wallet}>
      {d.receipts.length === 0 ? <Empty>No receipts yet.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-y border-border"><tr>{["Time", "Kind", "sha256", "Status", ""].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {d.receipts.map((r) => (
                <tr key={r.id} className="animate-row-in">
                  <td className={cn(td, "text-muted-foreground")}>{hms(r.created_at)}</td>
                  <td className={td}><Pill tone={r.kind === "approval" ? "info" : "primary"}>{r.kind}</Pill></td>
                  <td className={cn(td, "font-mono text-xs")}>{shortHash(r.sha256)}</td>
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

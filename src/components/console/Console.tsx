import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, Phone, Search } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { cents, countdown, hms, num, sha256Hex, shortHash, usd } from "@/lib/format";
import type { DashboardState, Intent, MarketContract, MarketEvent, Order, Receipt } from "./types";
import { Btn, Empty, JsonBlock, PageHeader, Panel, Pill, type Tone } from "./ui";

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
    <p className="tnum flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <span className="spinner spinner-ink" aria-hidden />
      <span>
        <span className="text-foreground">Waiting for backend…</span>{" "}
        {q.isError ? `dashboard-state unavailable (${(q.error as Error).message}) · retrying every 2.5s` : "connecting"}
      </span>
    </p>
  );
}

function useDrawer() {
  const [drawer, setDrawer] = useState<{ title: string; body: ReactNode } | null>(null);
  const open: Open = (title, body) => setDrawer({ title, body });
  const sheet = (
    <Sheet open={!!drawer} onOpenChange={(o) => !o && setDrawer(null)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader><SheetTitle className="break-all text-sm">{drawer?.title}</SheetTitle></SheetHeader>
        <div className="px-4 pb-6">{drawer?.body}</div>
      </SheetContent>
    </Sheet>
  );
  return { open, sheet };
}

export const Disclaimer = () => (
  <footer className="max-w-3xl pt-4 text-xs leading-relaxed text-muted-foreground">
    Sandbox only — test money, sandbox prices are not real market prices. The agent only speaks numbers returned by Gemini. Receipts prove what we recorded and when; Gemini's API is the source of truth for execution. No recommendations.
  </footer>
);

export function OverviewView() {
  const now = useNow();
  const q = useDashboardState();
  const d = q.data;
  const { open, sheet } = useDrawer();
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <PageHeader
        title="Account"
        right={d?.phone_number && (
          <a href={`tel:${d.phone_number}`} className="btn btn-quiet tnum">
            <Phone className="size-4" aria-hidden /> {d.phone_number}
          </a>
        )}
      />
      {d?.history_available === false && <p className="text-sm text-muted-foreground">Private account history unavailable.</p>}
      {!d ? <Waiting q={q} /> : (
        <>
          <AccountStrip d={d} />
          <Trades d={d} now={now} open={open} />
          <Positions d={d} open={open} />
          <Timeline d={d} open={open} />
          <Receipts d={d} open={open} />
        </>
      )}
      <Disclaimer />
      {sheet}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-4 py-1.5 text-sm">
      <dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="tnum min-w-0">
        {value}
        {sub && <span className="block text-xs text-destructive">{sub}</span>}
      </dd>
    </div>
  );
}

// Balance first, then account facts as a plain property list.
function AccountStrip({ d }: { d: DashboardState }) {
  const a = d.account;
  const l = d.limits;
  const money = (n: number) => usd(n).replace(".00", "");
  return (
    <section>
      <div className="text-sm text-muted-foreground">USD available</div>
      {a.configured ? (
        <div className="tnum mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">{usd(a.usd_available)}</div>
      ) : (
        <div className="mt-1 text-xl font-semibold text-warning">Gemini keys not configured yet</div>
      )}
      {a.balance_error && <div className="mt-1 text-sm text-destructive">{a.balance_error}</div>}
      <dl className="mt-5">
        {a.configured && (
          <>
            <Stat label="Open positions" value={a.positions?.length ?? 0} sub={a.positions_error} />
            <Stat label="Terms accepted" value={a.terms_accepted === null ? "—" : a.terms_accepted ? <span className="text-success">Yes</span> : <span className="text-destructive">No</span>} sub={a.terms_error} />
          </>
        )}
        <Stat label="Phone execution" value={d.execution_enabled ? "On" : "Off"} />
        <Stat label="Limits" value={`${money(l.maxOrderUsd)} per order · ${money(l.maxDailyUsd)} per day · max ${cents(l.maxLimitPrice)}`} />
      </dl>
    </section>
  );
}

function Timeline({ d, open }: { d: DashboardState; open: Open }) {
  return (
    <Panel title="Voice activity" right={<span className="tnum text-xs text-muted-foreground">{d.activity.length} events</span>}>
      {d.activity.length === 0 ? <Empty>No activity yet. Call the number to start.</Empty> : (
        <ul className="max-h-[32rem] overflow-y-auto">
          {d.activity.map((e) => (
            <li key={e.id} className="animate-row-in border-b border-border">
              <button
                onClick={() => open(`${e.kind} · ${hms(e.at)}`, <JsonBlock value={{ kind: e.kind, at: e.at, summary: e.summary }} />)}
                className="grid w-full grid-cols-[4.5rem_1fr] items-baseline gap-x-3 gap-y-0.5 py-2 text-left hover:bg-card md:grid-cols-[4.5rem_11rem_1fr_auto]"
              >
                <span className="tnum font-mono text-xs text-muted-foreground">{hms(e.at)}</span>
                <Pill tone={kindTone(e.kind)}>{e.kind.replace(/_/g, " ").toLowerCase()}</Pill>
                <span className="col-span-2 text-sm md:col-span-1">{e.summary}</span>
                <span className="tnum col-span-2 truncate text-xs text-muted-foreground md:col-span-1">{e.caller ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SideOutcome({ side, outcome }: { side: string; outcome: string }) {
  const yes = outcome.toUpperCase() === "YES";
  return (
    <span className="font-mono text-xs font-medium">
      {side.toUpperCase()} <span className={yes ? "text-success" : "text-destructive"}>{outcome.toUpperCase()}</span>
    </span>
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
      {pending.length === 0 && d.orders.length === 0 && <Empty>No trades yet.</Empty>}
      {pending.map((i) => <PendingCard key={i.id} i={i} now={now} />)}
      {d.orders.map((o) => <OrderCard key={o.id} o={o} i={byId.get(o.intent_id)} onRaw={() => open(`Raw Gemini response · ${o.gemini_order_id ?? o.id}`, <JsonBlock value={o} />)} onReceipts={() => showReceipts(o)} />)}
    </Panel>
  );
}

function PendingCard({ i, now }: { i: Intent; now: number }) {
  const left = countdown(i.expires_at, now);
  return (
    <div className="animate-row-in border-b border-border py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SideOutcome side={i.side} outcome={i.outcome} />
        <Pill tone="warning">Awaiting PIN · {left}</Pill>
      </div>
      <div className="mt-1 text-sm font-medium">{i.contract_label ?? i.instrument_symbol}</div>
      {i.title && <div className="text-xs text-muted-foreground">{i.title}</div>}
      <div className="mt-1 font-mono text-xs">Asked: {i.quantity} @ ≤ {cents(i.limit_price)} <span className="text-muted-foreground">· est. fee {usd(i.est_fee_usd)} · code {i.code}</span></div>
    </div>
  );
}

function OrderCard({ o, i, onRaw, onReceipts }: { o: Order; i: Intent | undefined; onRaw: () => void; onReceipts: () => void }) {
  return (
    <div className="animate-row-in border-b border-border py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SideOutcome side={o.side ?? i?.side ?? "?"} outcome={i?.outcome ?? "?"} />
        <Pill tone={summaryTone(o.outcome_summary)}>{(o.outcome_summary ?? o.exchange_status ?? "—").replace(/_/g, " ")}</Pill>
      </div>
      <div className="mt-1 text-sm font-medium">{i?.contract_label ?? i?.instrument_symbol ?? "Unknown contract"}</div>
      {i?.title && <div className="text-xs text-muted-foreground">{i.title}</div>}
      <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
        <dt className="text-muted-foreground">Asked</dt><dd>{i ? `${i.quantity} @ ≤ ${cents(i.limit_price)}` : "—"}</dd>
        <dt className="text-muted-foreground">Gemini filled</dt><dd className="text-foreground">{num(o.filled_qty)} @ {cents(o.avg_price)}</dd>
        <dt className="text-muted-foreground">Fee</dt><dd>{usd(i?.est_fee_usd)} est.</dd>
        <dt className="text-muted-foreground">Order id</dt><dd className="break-all">{o.gemini_order_id ?? "—"}</dd>
      </dl>
      {o.error && <div className="mt-2 break-words text-xs text-destructive">{o.error}</div>}
      <div className="mt-2 flex flex-wrap gap-2"><Btn onClick={onRaw}>Raw Gemini response</Btn><Btn onClick={onReceipts}>Receipts</Btn></div>
    </div>
  );
}

const tradable = (c: MarketContract) => c.status === "active" && c.market_state === "open";
const quoted = (c: MarketContract) => c.buy.yes !== null || c.buy.no !== null;
const contractState = (c: MarketContract) => [c.status, c.market_state].filter(Boolean).join(" · ") || "—";
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function expiryText(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
}
// Earliest contract expiry of an event; ISO strings compare chronologically.
const eventExpiry = (e: MarketEvent) => e.contracts.reduce<string | null>((min, c) => (c.expiry && (!min || c.expiry < min) ? c.expiry : min), null);

type ContractSort = { key: "label" | "yes" | "no"; dir: 1 | -1 };
type EventSort = "expiry" | "title";

function BuyPrice({ side, value }: { side: "Yes" | "No"; value: number | null }) {
  if (value === null || value === undefined)
    return <span className="inline-block min-w-16 rounded-md px-2 py-1 text-center font-mono text-xs text-muted-foreground" title={`No ${side} quote`}>—</span>;
  return (
    <span className={cn("tnum inline-block min-w-16 rounded-md px-2 py-1 text-center font-mono text-sm font-medium", side === "Yes" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
      {cents(value)}
    </span>
  );
}

function ContractRows({ event, sort, pick, onQuote }: { event: MarketEvent; sort: ContractSort; pick: (key: ContractSort["key"]) => void; onQuote: ((eventTicker: string, contractSymbol: string) => void) | undefined }) {
  const [details, setDetails] = useState<string | null>(null);
  const contracts = useMemo(() => {
    const value = (c: MarketContract) => (sort.key === "yes" ? c.buy.yes : sort.key === "no" ? c.buy.no : null);
    return [...event.contracts].sort((a, b) => {
      const byLabel = natural.compare(a.label ?? a.symbol, b.label ?? b.symbol);
      if (sort.key === "label") return byLabel * sort.dir;
      const x = value(a), y = value(b);
      if (x === y) return byLabel;
      if (x === null) return 1; // contracts without a quote stay last in either direction
      if (y === null) return -1;
      return (x - y) * sort.dir;
    });
  }, [event, sort]);
  const head = (key: ContractSort["key"], label: string, align = "") => (
    <th scope="col" className={cn("h-8 px-2 text-xs font-medium text-muted-foreground", align)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className={cn("inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground", sort.key === key && "text-foreground")} onClick={() => pick(key)}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
      </button>
    </th>
  );
  return (
    <table className="w-full border-collapse" aria-label={`${event.title} contracts`}>
      <thead>
        <tr className="border-b border-border">
          {head("label", "Outcome", "text-left")}
          {head("yes", "Buy Yes", "text-right")}
          {head("no", "Buy No", "text-right")}
          <th scope="col" className="hidden h-8 px-2 text-left text-xs font-medium text-muted-foreground sm:table-cell">Expires</th>
          <th scope="col" className="h-8 w-8 px-2"><span className="sr-only">Details</span></th>
        </tr>
      </thead>
      <tbody>
        {contracts.map((c) => {
          const open = details === c.symbol;
          const live = tradable(c);
          return (
            <Fragment key={c.symbol}>
              <tr className={cn("border-b border-border", open && "border-b-0")}>
                <th scope="row" className="max-w-0 w-full px-2 py-1.5 text-left text-sm font-normal">
                  <span className="block truncate">{c.label ?? c.symbol}</span>
                  {!live && <span className="block truncate text-xs text-muted-foreground">{contractState(c)}</span>}
                </th>
                {quoted(c) ? (
                  <>
                    <td className="px-1 py-1.5 text-right"><BuyPrice side="Yes" value={c.buy.yes} /></td>
                    <td className="px-1 py-1.5 text-right"><BuyPrice side="No" value={c.buy.no} /></td>
                  </>
                ) : (
                  <td colSpan={2} className="whitespace-nowrap px-2 py-1.5 text-right text-xs text-muted-foreground">No quote yet</td>
                )}
                <td className="tnum hidden whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground sm:table-cell">{expiryText(c.expiry)}</td>
                <td className="px-1 py-1.5 text-right">
                  <button
                    type="button"
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-expanded={open}
                    aria-label={`Bid and ask details for ${c.label ?? c.symbol}`}
                    onClick={() => setDetails(open ? null : c.symbol)}
                  >
                    <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} aria-hidden />
                  </button>
                </td>
              </tr>
              {open && (
                <tr className="border-b border-border">
                  <td colSpan={5} className="px-2 pb-3 pt-0.5">
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                      <div><dt className="text-muted-foreground">Yes ask / bid</dt><dd className="tnum font-mono text-sm">{cents(c.buy.yes)} / {cents(c.sell.yes)}</dd></div>
                      <div><dt className="text-muted-foreground">No ask / bid</dt><dd className="tnum font-mono text-sm">{cents(c.buy.no)} / {cents(c.sell.no)}</dd></div>
                      <div><dt className="text-muted-foreground">Expires</dt><dd className="tnum text-sm">{expiryText(c.expiry)}</dd></div>
                      <div><dt className="text-muted-foreground">Availability</dt><dd className="text-sm">{live ? "Open" : contractState(c)}</dd></div>
                    </dl>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="break-all font-mono text-xs text-muted-foreground">{c.symbol}</span>
                      {onQuote && <Btn onClick={() => onQuote(event.ticker, c.symbol)}>Fresh quote</Btn>}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// The live Gemini Sandbox listing from the shared dashboard feed, grouped by event. Pick an event to
// see its outcomes with Yes / No buy prices; each outcome opens to bid, ask and (when `onQuote` is
// given) a fresh quote.
export function MarketsTable({ onQuote }: { onQuote?: (eventTicker: string, contractSymbol: string) => void }) {
  const q = useDashboardState();
  const markets = q.data?.markets;
  const [filter, setFilter] = useState("");
  const [order, setOrder] = useState<EventSort>("expiry");
  const [sort, setSort] = useState<ContractSort>({ key: "label", dir: 1 });
  const [selected, setSelected] = useState<string | null | undefined>(undefined); // undefined: nothing chosen yet, show the first
  const [limit, setLimit] = useState(40);
  const all = useMemo(() => markets?.events ?? [], [markets]);
  const events = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);
    return all
      .map((event) => {
        // A match on the event keeps all its outcomes; otherwise keep only the matching outcomes.
        if (!needle || has(event.title) || has(event.ticker) || has(event.category)) return event;
        return { ...event, contracts: event.contracts.filter((c) => has(c.label) || has(c.symbol)) };
      })
      .filter((event) => event.contracts.length > 0)
      .sort((a, b) => {
        if (order === "expiry") {
          const x = eventExpiry(a), y = eventExpiry(b);
          if (x !== y) return !x ? 1 : !y ? -1 : x < y ? -1 : 1;
        }
        return natural.compare(a.title, b.title);
      });
  }, [all, filter, order]);
  const contractCount = events.reduce((n, e) => n + e.contracts.length, 0);
  const current = selected === undefined ? events[0]?.ticker : selected;
  const pick = (key: ContractSort["key"]) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "label" ? 1 : -1 }));

  return (
    <section aria-label="Gemini Sandbox market listings" className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="relative min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input className="field pl-8" aria-label="Filter events and outcomes" placeholder="Filter events and outcomes" value={filter} onChange={(e) => { setFilter(e.target.value); setLimit(40); setSelected(undefined); }} />
        </div>
        <label>
          <span className="sr-only">Order events by</span>
          <select className="field w-auto" value={order} onChange={(e) => setOrder(e.target.value as EventSort)}>
            <option value="expiry">Soonest expiry</option>
            <option value="title">Event A–Z</option>
          </select>
        </label>
        {markets && !markets.error && (
          <span className="tnum ml-auto text-xs text-muted-foreground">{events.length} {events.length === 1 ? "event" : "events"} · {contractCount} outcomes</span>
        )}
      </div>
      {!q.data ? <Waiting q={q} /> : !markets ? <Empty>Market listings are not included in the current dashboard feed.</Empty>
        : markets.error ? <Empty>Markets unavailable: {markets.error}</Empty>
        : events.length === 0 ? <Empty>{filter.trim() ? "No events or outcomes match this filter." : "No active contracts returned by Gemini Sandbox."}</Empty> : (
        <>
          <ul className="border-t border-border">
            {events.slice(0, limit).map((event) => {
              const open = current === event.ticker;
              const live = event.contracts.filter(tradable).length;
              const priced = event.contracts.filter(quoted).length;
              const only = event.contracts.length === 1 ? event.contracts[0] : undefined;
              return (
                <li key={event.ticker} className="border-b border-border">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setSelected(open ? null : event.ticker)}
                    className={cn("flex w-full items-center gap-2 px-1 py-2.5 text-left hover:bg-muted", open && "bg-muted")}
                  >
                    <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium sm:truncate">{event.title}</span>
                      <span className="tnum block truncate text-xs text-muted-foreground">
                        {[event.category, event.ticker, `${event.contracts.length} ${event.contracts.length === 1 ? "outcome" : "outcomes"}`, priced < event.contracts.length ? `${event.contracts.length - priced} without a quote` : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {!open && only && quoted(only) && (
                      <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-label={`Buy Yes ${cents(only.buy.yes)}, buy No ${cents(only.buy.no)}`}>
                        <BuyPrice side="Yes" value={only.buy.yes} />
                        <BuyPrice side="No" value={only.buy.no} />
                      </span>
                    )}
                    <span className="tnum shrink-0 text-right text-xs text-muted-foreground sm:w-36">
                      <span className="block">{expiryText(eventExpiry(event))}</span>
                      <span className={cn("block", live === event.contracts.length ? "text-success" : "")}>{live === event.contracts.length ? "Open" : live === 0 ? "Not open" : `${live} of ${event.contracts.length} open`}</span>
                    </span>
                  </button>
                  {open && (
                    <div className="pb-3 pl-5 pr-1 sm:pl-7">
                      <ContractRows event={event} sort={sort} pick={pick} onQuote={onQuote} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {events.length > limit && (
            <button type="button" className="btn btn-quiet mt-3" onClick={() => setLimit(events.length)}>Show all {events.length} events</button>
          )}
        </>
      )}
    </section>
  );
}

function Positions({ d, open }: { d: DashboardState; open: Open }) {
  const ps = d.account.positions ?? [];
  return (
    <Panel title="Positions" right={<Btn onClick={() => open("Position details", <JsonBlock value={d.account.positions} />)}>Position details</Btn>}>
      {ps.length === 0 ? <Empty>{d.account.positions_error ?? "No open positions."}</Empty> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr>{["Contract", "Outcome", "Qty", "Avg", "Bid", "Mkt value", "Unreal. P&L", "Status"].map((h, i) => <th key={h} scope="col" className={i > 1 && i < 7 ? "num" : ""}>{h}</th>)}</tr></thead>
            <tbody>
              {ps.map((p, idx) => (
                <tr key={`${p.symbol}-${p.outcome}-${idx}`}>
                  <td className="min-w-44 font-medium">{p.contract ?? p.symbol}{p.event && <div className="text-xs font-normal text-muted-foreground">{p.event}</div>}</td>
                  <td className={String(p.outcome).toLowerCase() === "yes" ? "text-success" : "text-destructive"}>{String(p.outcome).toUpperCase()}</td>
                  <td className="num">{p.quantity}{p.on_hold ? <span className="text-muted-foreground"> ({p.on_hold} held)</span> : null}</td>
                  <td className="num">{cents(p.avg_price)}</td>
                  <td className="num">{cents(p.bid)}</td>
                  <td className="num">{usd(p.market_value)}</td>
                  <td className={cn("num", p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "text-success" : "text-destructive")}>{usd(p.unrealized_pnl)}</td>
                  <td className="whitespace-nowrap text-subtle">{p.contract_status ?? "—"}{p.resolution_side ? ` · ${p.resolution_side}` : ""}</td>
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
      <a className="text-accent-foreground hover:underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/address/${s.address}?cluster=devnet`}>{shortHash(s.address, 6)}</a>
      <span className="text-muted-foreground">{s.balance_sol ?? "—"} SOL</span>
      {s.balance_sol === 0 && <a className="text-warning hover:underline" target="_blank" rel="noreferrer" href="https://faucet.solana.com">Fund at faucet.solana.com</a>}
    </div>
  ) : <span className="text-xs text-muted-foreground">No receipt wallet</span>;
  return (
    <Panel title="Onchain receipts (Solana devnet)" right={wallet}>
      {d.receipts.length === 0 ? <Empty>No receipts yet.</Empty> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr>{["Time", "Kind", "sha256", "Status", ""].map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {d.receipts.map((r) => (
                <tr key={r.id} className="animate-row-in">
                  <td className="tnum whitespace-nowrap font-mono text-xs text-muted-foreground">{hms(r.created_at)}</td>
                  <td>{r.kind}</td>
                  <td className="font-mono text-xs">{shortHash(r.sha256)}</td>
                  <td className="whitespace-nowrap">
                    {r.solana_sig ? (
                      <a className="text-success hover:underline" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${r.solana_sig}?cluster=devnet`}>✓ anchored</a>
                    ) : r.error === "anchoring…" ? <span className="text-muted-foreground">anchoring…</span>
                    : r.error ? <span className="text-destructive">{r.error}</span> : <span className="text-muted-foreground">pending</span>}
                  </td>
                  <td className="text-right"><Btn onClick={() => open(`Verify receipt · ${r.kind}`, <VerifyReceipt r={r} />)}>Verify</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

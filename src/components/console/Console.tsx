import { marketSearch } from "../../lib/market-search";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { workerTrading } from "../../browserTrading";
import { PrivatePortfolio } from "./PrivatePortfolio";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Phone, Search } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { cents, countdown, hms, num, sha256Hex, shortHash, usd } from "@/lib/format";
import type { DashboardState, Intent, MarketContract, MarketEvent, Order, Receipt } from "./types";
import type { MarketTools } from "@/pages/useMarketTools";
import { isMarketSort, marketSortLabels } from "@/lib/market-sort";
import { marketRank } from "@/lib/market-rank";
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
    <div className="console-account flex flex-col gap-4">
      <PageHeader
        title="Account"
        right={d?.phone_number && (
          <a href={`tel:${d.phone_number}`} className="btn btn-quiet tnum">
            <Phone className="size-4" aria-hidden /> {d.phone_number}
          </a>
        )}
      />
      {d ? (d.account.configured || !workerTrading) && <AccountStrip d={d} /> : <Waiting q={q} />}
      <Panel title={workerTrading && !d?.account.configured ? "Gemini Sandbox account" : "Gemini order history"}>
        <PrivatePortfolio showBalance={workerTrading && !d?.account.configured} showPositions={!d?.account.configured || Boolean(d.account.positions_error)} />
      </Panel>
      {d && (
        <>
          {(d.history_available !== false || d.orders.length > 0 || d.intents.length > 0) && <Trades d={d} now={now} open={open} />}
          {d.account.configured && <Positions d={d} open={open} />}
          {(d.history_available !== false || d.activity.length > 0) && <Timeline d={d} open={open} />}
          {(d.history_available !== false || d.receipts.length > 0) && <Receipts d={d} open={open} />}
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
  return (
    <section className="balance-card">
      <div className="text-sm text-muted-foreground">USD available</div>
      {a.configured ? (
        <div className="tnum mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">{usd(a.usd_available)}</div>
      ) : (
        <div className="mt-1 text-xl font-semibold text-warning">Sandbox balance unavailable</div>
      )}
      {a.balance_error && <div className="mt-1 text-sm text-destructive">{a.balance_error}</div>}
      <dl className="mt-5">
        {a.configured && (
          <>
            <Stat label="Open positions" value={a.positions_error || !Array.isArray(a.positions) ? "Unavailable" : a.positions.length} sub={a.positions_error} />
            <Stat label="Terms accepted" value={a.terms_accepted == null ? "—" : a.terms_accepted ? <span className="text-success">Yes</span> : <span className="text-destructive">No</span>} sub={a.terms_error} />
          </>
        )}
        <Stat label="Phone execution" value={d.execution_enabled ? "On" : "Off"} />
      </dl>
    </section>
  );
}

function Timeline({ d, open }: { d: DashboardState; open: Open }) {
  return (
    <Panel title="Voice activity" right={<span className="tnum text-xs text-muted-foreground">{d.activity.length} events</span>}>
      {d.activity.length === 0 ? <Empty>No voice activity recorded.</Empty> : (
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
    <Panel title="Trade journal">
      {pending.length === 0 && d.orders.length === 0 && <Empty>No trades recorded in the journal.</Empty>}
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
        <Pill tone="warning">Awaiting confirmation · {left}</Pill>
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
type MarketRow = { event: MarketEvent; contract: MarketContract };
const sorters = {
  event: ({event, contract}: MarketRow) => event.title + " " + contract.label,
  yesAsk: ({contract}: MarketRow) => contract.buy.yes,
  yesBid: ({contract}: MarketRow) => contract.sell.yes,
  noAsk: ({contract}: MarketRow) => contract.buy.no,
  noBid: ({contract}: MarketRow) => contract.sell.no,
  featured: ({event}: MarketRow) => marketRank("featured", event, null),
  newest: ({event}: MarketRow) => marketRank("newest", event, null),
  volume_24h: ({event}: MarketRow) => marketRank("volume_24h", event, null),
  volume: ({event}: MarketRow) => event.volume_usd ?? null,
  expiry: ({contract}: MarketRow) => Date.parse(contract.expiry ?? "") || null,
  status: ({contract}: MarketRow) => contract.market_state,
};
type SortKey = keyof typeof sorters;
const columns: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "event", label: "Event" },
  { key: "yesAsk", label: "YES ask", num: true },
  { key: "yesBid", label: "YES bid", num: true },
  { key: "noAsk", label: "NO ask", num: true },
  { key: "noBid", label: "NO bid", num: true },
  { key: "volume", label: "Event volume", num: true },
  { key: "expiry", label: "Expires (UTC)" },
  { key: "status", label: "Availability" },
];
function expiryText(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}
const Price = ({ v, tone }: { v: number | null; tone: string }) => (v === null || v === undefined ? <span className="text-muted-foreground">—</span> : <span className={tone}>{cents(v)}</span>);

// The live Gemini Sandbox listing from the shared dashboard feed: filter, sort by any column, and
// (when `onQuote` is given) request a fresh quote for a row.
export function MarketsTable({ market, onQuote }: { market: MarketTools; onQuote?: (eventTicker: string, contractSymbol: string) => void }) {
  const q = useDashboardState();
  const markets = q.data?.markets;
  const { browse } = market;
  const filter = browse.topic;
  const { endingMinutes, minVolume } = browse;
  const [openOnly, setOpenOnly] = useState(false);
  const now = useNow(5_000);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(() => ({
    key: browse.sort ?? "expiry", dir: browse.sort === "volume" || browse.sort === "volume_24h" || browse.sort === "newest" ? -1 : 1,
  }));
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    if (!market.result?.events || !browse.sort) return;
    setSort({ key: browse.sort, dir: browse.sort === "featured" || browse.sort === "expiry" ? 1 : -1 });
    setLimit(30);
  }, [browse.sort, market.result]);
  const all = useMemo(() => (markets?.events ?? []).flatMap((event) => event.contracts.map((contract) => ({ event, contract }))), [markets]);
  const rows = useMemo(() => {
    const search = marketSearch(filter, now);
    const get = sorters[sort.key];
    return all
      .filter(({ event, contract }) => {
        const expiry = Date.parse(contract.expiry ?? "");
        const nearestWindow = search.words.includes("05m");
        if ((openOnly || nearestWindow) && (!tradable(contract) || !(expiry > now))) return false;
        if (browse.sort === "expiry" && !(expiry > now)) return false;
        if (endingMinutes && !(expiry > now && expiry <= now + endingMinutes * 60_000)) return false;
        if (minVolume !== null && (event.volume_usd == null || event.volume_usd < minVolume)) return false;
        return search.matches(event, contract);
      })
      .sort((a, b) => {
        const x = get(a), y = get(b);
        if (x === y && isMarketSort(sort.key)) return 0;
        if (x === y) return sorters.event(a).localeCompare(sorters.event(b)) || a.contract.symbol.localeCompare(b.contract.symbol);
        if (x === null || x === undefined) return 1; // missing values last in either direction
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : 1) * sort.dir;
      });
  }, [all, filter, sort, browse.sort, endingMinutes, minVolume, openOnly, now]);
  const pick = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "volume" ? -1 : 1 }));
  const shown = rows.slice(0, limit);
  const state = (c: MarketContract) => [c.status, c.market_state].filter(Boolean).join(" · ") || "—";

  return (
    <section aria-label="Gemini Sandbox market listings" className="console-card">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input className="field pl-8" aria-label="Filter listed contracts" placeholder="Filter events and contracts" value={filter} onChange={(e) => { market.filterListings({ topic: e.target.value }); setLimit(30); }} />
        </div>
        <select className="field w-auto" aria-label="Time to expiry" value={endingMinutes ?? 0} onChange={e => { market.filterListings({ endingMinutes: Number(e.target.value) || null }); setLimit(30); }}>
          {endingMinutes != null && endingMinutes > 0 && ![5, 15, 60, 1440].includes(endingMinutes) && <option value={endingMinutes}>Ends within {endingMinutes}m</option>}<option value={0}>Any expiry</option><option value={5}>Ends within 5m</option><option value={15}>Ends within 15m</option><option value={60}>Ends within 1h</option><option value={1440}>Ends within 24h</option>
        </select>
        <input type="number" min="0" step="any" className="field w-36" aria-label="Minimum event volume in USD" placeholder="Min volume ($)" value={minVolume ?? ""} onChange={e => { market.filterListings({ minVolume: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) }); setLimit(30); }} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={openOnly} onChange={e => { setOpenOnly(e.target.checked); setLimit(30); }} /> Open only</label>
        <label className="flex items-center gap-2 text-sm">
          <span>Sort by</span>
          <select className="field w-auto" value={sort.key} onChange={(e) => {
            const key = e.target.value as SortKey;
            const descending = key === "volume" || key === "volume_24h" || key === "newest";
            setSort({ key, dir: descending ? -1 : 1 });
            setLimit(30);
            if (isMarketSort(key)) void market.run("search_markets", { query: browse.query, sort: key });
          }}>
            {Object.entries(marketSortLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            <optgroup label="Contract columns">
              {columns.filter(c => !isMarketSort(c.key)).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </optgroup>
          </select>
        </label>
        {markets && !markets.error && <span className="tnum ml-auto text-xs text-muted-foreground">{rows.length} of {all.length} contracts</span>}
      </div>
      {!q.data ? <Waiting q={q} /> : !markets ? <Empty>Market listings are not included in the current dashboard feed.</Empty>
        : markets.error ? <Empty>Markets unavailable: {markets.error}</Empty>
        : rows.length === 0 ? <Empty>{filter.trim() || endingMinutes || minVolume || openOnly ? "No listed contracts match these filters." : "No active contracts returned by Gemini Sandbox."}</Empty> : (
        <>
          <ul className="border-t border-border md:hidden">
            {shown.map(({ event, contract }) => (
              <li key={`${event.ticker}-${contract.symbol}`} className="flex items-center gap-3 border-b border-border py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{contract.label ?? contract.symbol}</div>
                  <div className="truncate text-xs text-muted-foreground">{event.title}</div>
                  <div className="tnum text-xs text-muted-foreground">{expiryText(contract.expiry)} UTC · {usd(sort.key === "volume_24h" ? event.volume_24h_usd : event.volume_usd)} {sort.key === "volume_24h" ? "24h" : "event"} volume · {tradable(contract) ? "open" : state(contract)}</div>
                </div>
                <div className="shrink-0 text-right font-mono text-xs">
                  <div>YES <Price v={contract.buy.yes} tone="text-success" /> / <Price v={contract.sell.yes} tone="text-success" /></div>
                  <div>NO <Price v={contract.buy.no} tone="text-destructive" /> / <Price v={contract.sell.no} tone="text-destructive" /></div>
                </div>
                {onQuote && <button type="button" className="btn btn-chip shrink-0" aria-label={`Fresh quote for ${contract.label ?? contract.symbol}`} onClick={() => onQuote(event.ticker, contract.symbol)}>Quote</button>}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="data" aria-label="Gemini Sandbox prediction markets">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className={c.num ? "num" : ""} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                      <button type="button" className="sort" data-active={sort.key === c.key} onClick={() => pick(c.key)}>
                        {c.key === "volume" && sort.key === "volume_24h" ? "24h volume" : c.label}
                        {sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
                      </button>
                    </th>
                  ))}
                  {onQuote && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {shown.map(({ event, contract }) => (
                  <tr key={`${event.ticker}-${contract.symbol}`}>
                    <td className="w-full max-w-0">
                      <div className="truncate font-medium" title={event.title}>{event.title}</div>
                      <div className="truncate text-xs text-muted-foreground">{[contract.label ?? contract.symbol, event.category].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="num"><Price v={contract.buy.yes} tone="text-success" /></td>
                    <td className="num"><Price v={contract.sell.yes} tone="text-success" /></td>
                    <td className="num"><Price v={contract.buy.no} tone="text-destructive" /></td>
                    <td className="num"><Price v={contract.sell.no} tone="text-destructive" /></td>
                    <td className="num" title={sort.key === "volume_24h" ? "Volume over the last 24 hours" : "Total traded across this event"}>{usd(sort.key === "volume_24h" ? event.volume_24h_usd : event.volume_usd)}</td>
                    <td className="tnum whitespace-nowrap text-subtle">{expiryText(contract.expiry)}</td>
                    <td className="whitespace-nowrap">{tradable(contract) ? <Pill tone="success">Open</Pill> : <Pill tone="muted">{state(contract)}</Pill>}</td>
                    {onQuote && <td className="text-right"><button type="button" className="btn btn-chip" aria-label={`Fresh quote for ${contract.label ?? contract.symbol}`} onClick={() => onQuote(event.ticker, contract.symbol)}>Quote</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > limit && (
            <button type="button" className="btn btn-quiet mt-3" onClick={() => setLimit(rows.length)}>Show all {rows.length}</button>
          )}
        </>
      )}
    </section>
  );
}

function Positions({ d, open }: { d: DashboardState; open: Open }) {
  const ps = d.account.positions ?? [];
  return (
    <Panel title="Positions" right={ps.length > 0 && <Btn onClick={() => open("Position details", <JsonBlock value={d.account.positions} />)}>Position details</Btn>}>
      {ps.length === 0 ? <Empty>{d.account.positions_error ?? (Array.isArray(d.account.positions) ? "Gemini reports no open positions." : "Position data unavailable.")}</Empty> : (
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

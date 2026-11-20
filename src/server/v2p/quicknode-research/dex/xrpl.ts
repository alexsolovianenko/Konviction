// Native XRP Ledger DEX trades against Ripple USD (RLUSD) through the XRP/RLUSD AMM, decoded from
// validated transaction metadata (the AMM account's XRP balance and its RLUSD trust line).
// Verified on 2026-11-20: amm_info for XRP / RLUSD (issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De, the
// Ripple-published RLUSD issuer whose Domain is ripple.com) returns AMM account
// rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3, and account_info shows its AMMID.
// Order-book (CLOB) fills that do not touch the AMM are not included; open offers never are.
import type { PoolRef, ReportInput } from "./report";
import { RpcFailure, type Rpc } from "./rpc";
import { TIMEFRAME_SECONDS, type SwapLeg, type Timeframe } from "./volume";

export const XRPL_AMM = {
  account: "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3",
  issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  /** "RLUSD" as a 160-bit currency code. */
  currency: "524C555344000000000000000000000000000000",
  pair: "XRP/RLUSD AMM",
  dex: "XRP Ledger AMM",
};
export const RIPPLE_EPOCH = 946684800;
export const XRPL_PAGE = 200;
export const XRPL_PAGES: Record<Timeframe, number> = { "5m": 1, "15m": 1, "1h": 2, "24h": 10 };
export const xrplMaxCalls = (tf: Timeframe) => XRPL_PAGES[tf];

export function xrplAllowed(method: string, params: unknown): boolean {
  if (method !== "account_tx" || !params || typeof params !== "object" || Array.isArray(params))
    return false;
  const o = params as Record<string, unknown>;
  const keys = Object.keys(o).sort().join();
  const base = "account,forward,ledger_index_max,ledger_index_min,limit";
  if (keys !== base && keys !== "account,forward,ledger_index_max,ledger_index_min,limit,marker")
    return false;
  if (o["marker"] !== undefined) {
    const m = o["marker"] as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || Object.keys(m).sort().join() !== "ledger,seq") return false;
    if (!Number.isInteger(m["ledger"]) || !Number.isInteger(m["seq"])) return false;
  }
  return (
    o["account"] === XRPL_AMM.account &&
    o["limit"] === XRPL_PAGE &&
    o["forward"] === false &&
    o["ledger_index_min"] === -1 &&
    o["ledger_index_max"] === -1
  );
}

type Node = Record<string, unknown>;
type Entry = Record<string, unknown>;

/** Parse an XRPL issued-currency decimal string ("123.45", "-1e-3") into a number. */
const dec = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Fields shared by API v1 ({tx}) and v2 ({tx_json, hash}) account_tx entries. */
export function entryFields(e: Entry) {
  const tx = (e["tx_json"] ?? e["tx"] ?? {}) as Record<string, unknown>;
  const hash =
    typeof e["hash"] === "string" ? e["hash"] : typeof tx["hash"] === "string" ? tx["hash"] : null;
  const date = typeof tx["date"] === "number" ? tx["date"] : null;
  return { hash, time: date === null ? null : date + RIPPLE_EPOCH };
}

/**
 * Decode one validated transaction touching the AMM. A swap moves the AMM's XRP and RLUSD in
 * opposite directions; deposits and withdrawals move both the same way and are ignored.
 */
export function decodeXrplEntry(e: Entry): SwapLeg | null {
  if (e["validated"] !== true) return null;
  const meta = (e["meta"] ?? null) as Record<string, unknown> | null;
  if (!meta || meta["TransactionResult"] !== "tesSUCCESS") return null;
  const { hash, time } = entryFields(e);
  if (!hash || time === null) return null;
  const A = XRPL_AMM;
  let dx: bigint | null = null;
  let du: number | null = null;
  for (const n of (Array.isArray(meta["AffectedNodes"]) ? meta["AffectedNodes"] : []) as Node[]) {
    const m = n?.["ModifiedNode"] as Node | undefined;
    if (!m) continue;
    const f = (m["FinalFields"] ?? {}) as Record<string, unknown>;
    const p = (m["PreviousFields"] ?? {}) as Record<string, unknown>;
    if (m["LedgerEntryType"] === "AccountRoot" && f["Account"] === A.account) {
      if (
        typeof f["Balance"] === "string" &&
        typeof p["Balance"] === "string" &&
        /^\d+$/.test(f["Balance"]) &&
        /^\d+$/.test(p["Balance"])
      )
        dx = BigInt(f["Balance"]) - BigInt(p["Balance"]);
    }
    if (m["LedgerEntryType"] === "RippleState") {
      const hi = (f["HighLimit"] ?? {}) as Record<string, unknown>;
      const lo = (f["LowLimit"] ?? {}) as Record<string, unknown>;
      const fb = (f["Balance"] ?? {}) as Record<string, unknown>;
      const pb = (p["Balance"] ?? {}) as Record<string, unknown>;
      if (fb["currency"] !== A.currency || hi["currency"] !== A.currency) continue;
      const ammLow = lo["issuer"] === A.account && hi["issuer"] === A.issuer;
      const ammHigh = hi["issuer"] === A.account && lo["issuer"] === A.issuer;
      if (!ammLow && !ammHigh) continue;
      const fv = dec(fb["value"]);
      const pv = dec(pb["value"]);
      if (fv === null || pv === null) continue;
      // Balance is from the low account's side: positive means the low account holds RLUSD.
      du = (ammLow ? 1 : -1) * (fv - pv);
    }
  }
  if (dx === null || du === null || dx === 0n || Math.abs(du) < 1e-12) return null;
  if (dx > 0n === du > 0) return null;
  return {
    tx: hash.toUpperCase(),
    leg: "amm",
    time,
    asset: -Number(dx) / 1e6, // XRP drops; trader receives what the AMM sends
    usd: Math.abs(du),
    pool: A.account,
  };
}

export async function runXrpl(
  tf: Timeframe,
  rpc: Rpc,
  nowMs: number,
): Promise<Omit<ReportInput, "callsUsed" | "observedAt">> {
  const now = Math.floor(nowMs / 1000);
  const start = now - TIMEFRAME_SECONDS[tf];
  const A = XRPL_AMM;
  const warnings: string[] = [];
  const pools: PoolRef[] = [
    {
      dex: A.dex,
      pair: A.pair,
      address: A.account,
      url: `https://livenet.xrpl.org/accounts/${A.account}`,
    },
  ];
  const common = {
    asset: "XRP",
    assetNote: null,
    chain: "XRP Ledger",
    source: "QuickNode x402 xrp-mainnet",
    method: "account_tx (validated AMM metadata)",
    timeframe: tf,
    pools,
    coverage: `XRP/RLUSD AMM swaps only (RLUSD issued by Ripple). Order-book fills that bypass the AMM, other quote assets and centralized exchanges are not included.`,
    txUrl: (h: string) => `https://livenet.xrpl.org/transactions/${h}`,
  };
  const entries: Entry[] = [];
  let reachedStart = false;
  let failed = false;
  let marker: unknown;
  try {
    for (let page = 0; page < XRPL_PAGES[tf]; page++) {
      const res = (await rpc("account_tx", {
        account: A.account,
        limit: XRPL_PAGE,
        forward: false,
        ledger_index_min: -1,
        ledger_index_max: -1,
        ...(marker ? { marker } : {}),
      })) as Record<string, unknown>;
      const list = Array.isArray(res?.["transactions"]) ? (res["transactions"] as Entry[]) : null;
      if (!list) throw new RpcFailure("parse", "account_tx returned no transactions list.");
      entries.push(...list);
      const times = list.map((x) => entryFields(x).time).filter((t): t is number => t !== null);
      marker = res["marker"];
      if (!marker || (times.length && Math.min(...times) < start)) {
        reachedStart = true;
        break;
      }
    }
  } catch (e) {
    failed = true;
    warnings.push(`AMM transaction history unavailable: ${(e as Error).message}`);
  }
  const times = entries.map((x) => entryFields(x).time).filter((t): t is number => t !== null);
  if (!reachedStart && !times.length)
    return { ...common, window: null, complete: false, legs: [], poolTxCount: null, warnings };
  if (!reachedStart && !failed)
    warnings.push(
      `AMM history was capped at ${XRPL_PAGES[tf]} page(s) of ${XRPL_PAGE} transactions.`,
    );
  const legs: SwapLeg[] = [];
  let other = 0;
  let unvalidated = 0;
  for (const e of entries) {
    if (e["validated"] !== true) {
      unvalidated++;
      continue;
    }
    const leg = decodeXrplEntry(e);
    if (leg) legs.push(leg);
    else other++;
  }
  if (unvalidated) warnings.push(`${unvalidated} unvalidated transactions were ignored.`);
  if (other)
    warnings.push(
      `${other} AMM transactions were deposits, withdrawals, failures or did not move both sides, and were ignored.`,
    );
  const from = reachedStart ? start : Math.min(...times) + 1;
  return {
    ...common,
    window: from < now ? { from, to: now } : null,
    complete: reachedStart,
    legs,
    poolTxCount: reachedStart
      ? entries.filter((e) => {
          const t = entryFields(e).time;
          return (
            t !== null &&
            t >= start &&
            e["validated"] === true &&
            ((e["meta"] ?? {}) as Record<string, unknown>)["TransactionResult"] === "tesSUCCESS"
          );
        }).length
      : null,
    warnings,
  };
}

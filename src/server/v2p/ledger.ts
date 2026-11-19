// @ts-nocheck -- supabase-js rows are untyped here, like the rest of src/server/v2p.
// One account-wide daily risk ledger shared by every channel (browser approval, phone tools).
// Committed today = filled buy notional + full reservations for orders whose outcome is not yet
// known or final (PENDING_UNKNOWN or OPEN) + full reservations for intents currently EXECUTING.
import { db } from "./db";
import { round2 } from "./util";

export type Ledger = { committedUsd: (opts?: { excludeIntentId?: string }) => Promise<number | null> };

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};
const cost = (r) => Number(r?.notional_usd ?? 0) + Number(r?.est_fee_usd ?? 0);

/** Returns null when historical exposure cannot be read. */
export const supabaseLedger: Ledger = {
  async committedUsd({ excludeIntentId } = {}) {
    const [orders, executing] = await Promise.all([
      db.from("orders").select("intent_id,outcome_summary,filled_notional_usd,market_fee:raw->result->>est_fee_usd")
        .eq("side", "buy").or(`created_at.gte.${startOfUtcDay()},outcome_summary.eq.PENDING_UNKNOWN,outcome_summary.eq.OPEN`),
      db.from("intents").select("id,notional_usd,est_fee_usd").eq("status", "EXECUTING").eq("side", "buy"),
    ]);
    if (orders.error || executing.error) return null;
    let total = 0;
    const recordedIds = new Set();
    const unknownIds = [];
    for (const o of orders.data ?? []) {
      recordedIds.add(o.intent_id);
      if (o.outcome_summary === "PENDING_UNKNOWN" || o.outcome_summary === "OPEN") unknownIds.push(o.intent_id);
      else total += Number(o.filled_notional_usd ?? 0) + Number(o.market_fee ?? 0);
    }
    if (unknownIds.length) {
      const { data, error } = await db.from("intents").select("id,notional_usd,est_fee_usd").in("id", unknownIds);
      if (error || data?.length !== unknownIds.length) return null;
      for (const r of data ?? []) total += cost(r);
    }
    for (const r of executing.data ?? []) if (r.id !== excludeIntentId && !recordedIds.has(r.id)) total += cost(r);
    return round2(total);
  },
};

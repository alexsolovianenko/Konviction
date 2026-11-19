import { settledOpenOrders } from "./reconcile-open";
// A single conditional write commits every reservation against the same account total.
// An unresolved submission stays reserved until its exchange result is known.
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { TradeError } from "./browser-trading";
import { SESSION_PREFIX, SESSION_TTL_MS } from "./browser-session";

interface Guard { phone: string; pin_failures: number; locked_until: string | null; expires: number | null }
interface Intent {
  instrument_symbol?: string; id: string; caller: string; status: string; side: string; expires_at: string; updated_at: number;
  quantity: number; limit_price: number; notional_usd: number; est_fee_usd: number;
}
interface Order { raw?: { result?: {order_mode?: string; est_fee_usd?: number} }; gemini_order_id?: string; intent_id: string; outcome_summary: string; filled_notional_usd: number; created_at: number }
interface State { version: 1; guards: Record<string, Guard>; intents: Record<string, Intent>; orders: Record<string, Order> }
const path = "browser-trading/v1/account.json";
const empty = (): State => ({ version: 1, guards: {}, intents: {}, orders: {} });

const backend = {
  async read() {
    // A compressed response can have a weak ETag, which cannot authorize an ifMatch write.
    const blob = await get(path, { access: "private", useCache: false, headers: { "Accept-Encoding": "identity" } });
    if (!blob) return null;
    if (blob.statusCode !== 200 || !blob.blob.etag) throw new Error("Ledger read unavailable");
    const state = await new Response(blob.stream).json() as State;
    if (state.version !== 1 || !state.guards || !state.intents || !state.orders) throw new Error("Invalid ledger");
    return { state, etag: blob.blob.etag };
  },
  async write(state: State, etag?: string) {
    try {
      await put(path, JSON.stringify(state), { access: "private", addRandomSuffix: false, contentType: "application/json",
        allowOverwrite: Boolean(etag), ...(etag && { ifMatch: etag }) });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      // A concurrent first write can report "already exists" instead of a precondition error.
      if (!etag && /already exists/i.test(String(error))) return false;
      throw error;
    }
  },
};

function committed(state: State, exclude?: string) {
  const today = new Date().setUTCHours(0, 0, 0, 0);
  let sum = 0;
  for (const it of Object.values(state.intents)) {
    if (it.id === exclude || it.side !== "buy") continue;
    const order = state.orders[it.id];
    if (order?.outcome_summary === "OPEN" || order?.outcome_summary === "PENDING_UNKNOWN" || (!order && it.status === "EXECUTING")) {
      sum += Number(it.notional_usd) + Number(it.est_fee_usd);
    } else if (order && order.created_at >= today && order.filled_notional_usd > 0) {
      const result = order.raw?.result;
      const fee = result?.order_mode === "market" ? result.est_fee_usd : it.est_fee_usd;
      sum += Number(order.filled_notional_usd) + Number(fee);
    }
  }
  if (!Number.isFinite(sum)) throw new Error("Invalid reservation");
  return Math.round(sum * 100) / 100;
}

function prune(state: State) {
  const now = Date.now();
  for (const guard of Object.values(state.guards)) {
    if (guard.expires !== null && guard.expires <= now) delete state.guards[guard.phone];
  }
  for (const it of Object.values(state.intents)) {
    // Immutable receipts are separate. Keep replay details longer than the bearer lifetime and UTC risk day.
    if (it.updated_at > now - 2 * 86400000 || it.status === "EXECUTING" || ["OPEN", "PENDING_UNKNOWN"].includes(state.orders[it.id]?.outcome_summary ?? "")) continue;
    delete state.intents[it.id];
    delete state.orders[it.id];
  }
}

function active(state: State, key: string) {
  const g = state.guards[key];
  if (!g || (g.expires !== null && g.expires <= Date.now())) throw new TradeError("UNAUTHORIZED", "Start a new voice session.", 401);
  if (g.locked_until && Date.parse(g.locked_until) > Date.now()) throw new TradeError("LOCKED", "Voice approval is locked.", 423);
  return g;
}

export function blobStore(io = backend) {
  async function update<T>(fn: (state: State) => T): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const snapshot = await io.read();
      const state = snapshot?.state ?? empty();
      prune(state);
      const result = fn(state);
      if (await io.write(state, snapshot?.etag)) return result;
      await new Promise(resolve => setTimeout(resolve, Math.random() * 25 * (attempt + 1)));
    }
    throw new TradeError("SERVICE_UNAVAILABLE", "The approval service is busy. Please try again.", 503);
  }
  const read = async () => (await io.read())?.state ?? empty();
  const guard = (phone: string, expires: number | null): Guard => ({ phone, expires, pin_failures: 0, locked_until: null });
  async function archive(name: string, data: unknown) {
    await put("browser-trading/v1/" + name + ".json", JSON.stringify(data), {
      access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json",
    });
  }
  return {
    async createSession(sid: string) {
      const key = SESSION_PREFIX + sid;
      await update(s => { s.guards[key] = guard(key, Date.now() + SESSION_TTL_MS); });
    },
    async getGuard(key: string) { return (await read()).guards[key] ?? null; },
    async setGuard(key: string, failures: number, until: string | null) {
      await update(s => { if (s.guards[key]) Object.assign(s.guards[key], { pin_failures: failures, locked_until: until }); });
    },
    async supersede(_caller: string) { /* Performed atomically in insertIntent. */ },
    async dismissProposal(id: string, caller: string) {
      await update(s => {
        const it = s.intents[id];
        if (it?.caller === caller && it.status === "PROPOSED") it.status = "SUPERSEDED";
      });
    },
    async insertIntent(row: Omit<Intent, "id" | "updated_at" | "status">) {
      const id = crypto.randomUUID();
      return update(s => {
        active(s, row.caller);
        for (const it of Object.values(s.intents)) if (it.caller === row.caller && it.status === "PROPOSED") it.status = "SUPERSEDED";
        s.intents[id] = { ...row, id, updated_at: Date.now(), status: "PROPOSED" };
        return id;
      });
    },
    async claim(id: string, caller: string) {
      return update(s => {
        active(s, caller);
        const it = s.intents[id];
        if (!it || it.caller !== caller || it.status !== "PROPOSED" || !["buy", "sell"].includes(it.side) || !(Date.parse(it.expires_at) > Date.now())) return null;
        it.status = "EXECUTING";
        it.updated_at = Date.now();
        return it;
      });
    },
    async getIntent(id: string) { return (await read()).intents[id] ?? null; },
    async setIntentStatus(id: string, status: string) {
      await update(s => {
        const it = s.intents[id];
        if (!it || it.status !== "EXECUTING") throw new Error("Invalid proposal transition");
        it.status = status;
        it.updated_at = Date.now();
      });
    },
    async getOrderByIntent(id: string) { return (await read()).orders[id] ?? null; },
    async saveOrder(row: Omit<Order, "created_at">) {
      await update(s => {
        if (s.intents[row.intent_id]?.status !== "EXECUTING" || s.orders[row.intent_id]) throw new Error("Invalid order transition");
        s.orders[row.intent_id] = { ...row, created_at: Date.now() };
      });
    },
    async reconcileOpen(history?: Parameters<typeof settledOpenOrders>[1]) {
      const snapshot = await read();
      const open = Object.values(snapshot.orders).flatMap(row => {
        const it = snapshot.intents[row.intent_id];
        if (row.outcome_summary !== "OPEN" || !row.gemini_order_id || !it?.instrument_symbol) return [];
        return [{ ...row, side: it.side, gemini_order_id: row.gemini_order_id, instrument_symbol: it.instrument_symbol,
          limit_price: it.limit_price, quantity: it.quantity }];
      });
      const settled = await settledOpenOrders(open, history);
      if (!settled.length) return;
      await update(state => {
        for (const fields of settled) {
          const row = state.orders[fields.intent_id];
          if (row?.outcome_summary === "OPEN") {
            Object.assign(row, fields, { created_at: Date.now() });
            const intent = state.intents[fields.intent_id];
            if (intent) intent.updated_at = Date.now();
          }
        }
      });
    },
    async committedUsd({ excludeIntentId }: { excludeIntentId?: string } = {}) { return committed(await read(), excludeIntentId); },
    async log(kind: string, caller: string | null, summary: string, detail?: unknown) {
      await archive("activity/" + crypto.randomUUID(), { kind, caller, summary, detail, at: new Date().toISOString() });
    },
    async receipt(intentId: string, code: string, kind: string, payload: unknown) {
      await archive("receipts/" + intentId + "/" + kind, { code, kind, payload, at: new Date().toISOString() });
    },
  };
}

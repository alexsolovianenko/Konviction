// A single conditional write commits every reservation against the same account total.
// An unresolved submission stays reserved until its exchange result is known.
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { GLOBAL_GUARD, GLOBAL_PIN_ATTEMPTS, SESSION_PIN_ATTEMPTS, PIN_LOCK_MS, TradeError } from "./browser-trading";
import { SESSION_PREFIX, SESSION_TTL_MS } from "./browser-session";
import { dailyCapError, orderCapError } from "./ledger";

interface Guard { phone: string; pin_failures: number; locked_until: string | null; expires: number | null }
interface Intent {
  id: string; caller: string; status: string; side: string; expires_at: string; updated_at: number;
  quantity: number; limit_price: number; notional_usd: number; est_fee_usd: number;
}
interface Order { intent_id: string; outcome_summary: string; filled_notional_usd: number; created_at: number }
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
    if (order?.outcome_summary === "PENDING_UNKNOWN" || (!order && it.status === "EXECUTING")) {
      sum += Number(it.notional_usd) + Number(it.est_fee_usd);
    } else if (order && order.created_at >= today && order.filled_notional_usd > 0) {
      sum += Number(order.filled_notional_usd) + Number(it.est_fee_usd);
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
    if (it.updated_at > now - 2 * 86400000 || it.status === "EXECUTING" || state.orders[it.id]?.outcome_summary === "PENDING_UNKNOWN") continue;
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
    async verifyPinAttempt(key: string | null, correct: boolean) {
      const passed = await update(s => {
        const session = key ? active(s, key) : null;
        const global = s.guards[GLOBAL_GUARD] ??= guard(GLOBAL_GUARD, null);
        if (global.locked_until && Date.parse(global.locked_until) > Date.now()) throw new TradeError("LOCKED", "Too many wrong PINs. Try again in 15 minutes.", 429);
        for (const entry of session ? [global, session] : [global]) {
          entry.pin_failures = correct ? 0 : entry.pin_failures + 1;
          if (entry.pin_failures >= (entry === global ? GLOBAL_PIN_ATTEMPTS : SESSION_PIN_ATTEMPTS)) {
            entry.locked_until = new Date(Date.now() + PIN_LOCK_MS).toISOString();
            entry.pin_failures = 0;
          }
        }
        return correct;
      });
      if (!passed) throw new TradeError("WRONG_PIN", "Incorrect PIN. Nothing was placed.", 403);
    },
    async supersede(_caller: string) { /* Performed atomically in insertIntent. */ },
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
        if (!it || it.caller !== caller || it.status !== "PROPOSED" || it.side !== "buy" || !(Date.parse(it.expires_at) > Date.now())) return null;
        const cap = orderCapError(it) ?? dailyCapError(committed(s), Number(it.notional_usd) + Number(it.est_fee_usd));
        if (cap) throw new TradeError("CAP_EXCEEDED", cap);
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
    async committedUsd({ excludeIntentId }: { excludeIntentId?: string } = {}) { return committed(await read(), excludeIntentId); },
    async log(kind: string, caller: string | null, summary: string, detail?: unknown) {
      await archive("activity/" + crypto.randomUUID(), { kind, caller, summary, detail, at: new Date().toISOString() });
    },
    async receipt(intentId: string, code: string, kind: string, payload: unknown) {
      await archive("receipts/" + intentId + "/" + kind, { code, kind, payload, at: new Date().toISOString() });
    },
  };
}

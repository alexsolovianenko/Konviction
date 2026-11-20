// Durable, atomic research payment ledger. Separate from the trading ledger on purpose: nothing here
// can reserve, approve or submit a Gemini order.
// Hosted: one private Vercel Blob updated only with ETag conditional writes (compare-and-swap), the
// same compare-and-swap pattern the trading ledger uses. Tests/local: in-memory, which is NEVER
// durable, so approval refuses to pay with it (fail closed).
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { Requirement } from "./x402";
import type { ResearchReport } from "./aggregate";
import type { MarketContext } from "./context";
import type { Timeframe } from "./dex/volume";

export type PurchaseStatus =
  | "quoted" // unpaid 402 captured; nothing signed
  | "free" // provider answered without payment; nothing charged
  | "expired" // quote TTL passed; nothing signed
  | "reserved" // budget held atomically; network not yet contacted for payment
  | "sending" // payment may be signed and sent; never retried
  | "paid" // provider returned data after payment (Gateway batch settles later)
  | "unknown_pending" // payment may have been sent but the outcome is unknown; never auto-resent
  | "failed"; // refused or failed before any payment was signed; budget released

export type Evidence = {
  http_status: number | null;
  rpc_error: string | null;
  request_id: string | null;
  api_ms: number | null;
  payment_response: Record<string, string | boolean | null> | null;
  payment_response_present: boolean;
  signed: boolean;
  gateway_available_before: string | null;
  gateway_available_after: string | null;
  gateway_deduction_atomic: string | null;
  response_sha256: string | null;
  /** Paid DEX sessions: requests sent, HTTP 200 responses, and payment payloads created. */
  calls_sent?: number;
  calls_ok?: number;
  calls_signed?: number;
};

export type Purchase = {
  id: string;
  sid: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  status: PurchaseStatus;
  /** Identified asset, exact market and free context at quote time. */
  context: MarketContext;
  /** Paid route chosen for this asset (routes.ts) and its fixed resource URL. */
  route_id: string;
  resource_url: string;
  /** Per-call requirement (each paid RPC call is one nanopayment of requirement.amount). */
  requirement: Requirement | null;
  /**
   * Budget held by this purchase. Quoted: the approved maximum (per-call price x max calls).
   * After a paid session: per-call price x payments actually created (never less than charged).
   */
  price_atomic: string;
  /** DEX research plan: timeframe, max paid calls and the approved maximum. */
  timeframe?: Timeframe;
  calls_planned?: number;
  max_atomic?: string;
  idempotency_key: string | null;
  reserved_at: number | null;
  payer: string | null;
  evidence: Evidence | null;
  report: ResearchReport | null;
  error: string | null;
};

type State = { version: 1; purchases: Record<string, Purchase> };
const empty = (): State => ({ version: 1, purchases: {} });

export type StoreIO = {
  /** True only for storage shared by every server instance with conditional writes. */
  readonly durable: boolean;
  read(): Promise<{ state: State; etag?: string } | null>;
  write(state: State, etag?: string): Promise<boolean>;
};

const PATH = "quicknode-research/v2/ledger.json";

export const blobIO: StoreIO = {
  durable: true,
  async read() {
    // A compressed response can carry a weak ETag that cannot authorize an ifMatch write.
    const blob = await get(PATH, {
      access: "private",
      useCache: false,
      headers: { "Accept-Encoding": "identity" },
    });
    if (!blob) return null;
    if (blob.statusCode !== 200 || !blob.blob.etag)
      throw new Error("Research ledger read unavailable");
    const state = (await new Response(blob.stream).json()) as State;
    if (state?.version !== 1 || !state.purchases) throw new Error("Invalid research ledger");
    return { state, etag: blob.blob.etag };
  },
  async write(state, etag) {
    try {
      await put(PATH, JSON.stringify(state), {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json",
        allowOverwrite: Boolean(etag),
        ...(etag && { ifMatch: etag }),
      });
      return true;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return false;
      if (!etag && /already exists/i.test(String(error))) return false;
      throw error;
    }
  },
};

/** Per-process compare-and-swap storage for tests and local runs. Never durable. */
export function memoryIO(opts: { durable?: boolean } = {}): StoreIO {
  let snap: { state: State; etag: string } | null = null;
  let n = 0;
  return {
    durable: opts.durable ?? false,
    async read() {
      return snap ? { state: structuredClone(snap.state), etag: snap.etag } : null;
    },
    async write(state, etag) {
      if ((snap?.etag ?? undefined) !== etag) return false;
      snap = { state: structuredClone(state), etag: String(++n) };
      return true;
    },
  };
}

export class ResearchError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Statuses that hold budget: money is or may be committed. */
export const HOLDING: PurchaseStatus[] = ["reserved", "sending", "paid", "unknown_pending"];

export type Caps = { perRequest: bigint; perSession: bigint; perDay: bigint };

export function researchStore(io: StoreIO) {
  async function update<T>(fn: (s: State) => T): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const snap = await io.read();
      const state = snap?.state ?? empty();
      prune(state);
      const out = fn(state);
      if (await io.write(state, snap?.etag)) return out;
      await new Promise((r) => setTimeout(r, Math.random() * 25 * (attempt + 1)));
    }
    throw new ResearchError("BUSY", "Research service busy. Nothing was paid.", 503);
  }
  const owned = (s: State, id: string, sid: string) => {
    const p = s.purchases[id];
    // Wrong session and unknown id are indistinguishable to the caller.
    if (!p || p.sid !== sid) throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
    return p;
  };
  return {
    io,
    async insert(p: Omit<Purchase, "id" | "created_at" | "updated_at">) {
      const id = crypto.randomUUID();
      const now = Date.now();
      return update((s) => {
        s.purchases[id] = { ...p, id, created_at: now, updated_at: now };
        return { ...s.purchases[id]! };
      });
    },
    async get(id: string, sid: string) {
      const s = (await io.read())?.state ?? empty();
      prune(s);
      return { ...owned(s, id, sid) };
    },
    /**
     * The only transition into spending. Atomic compare-and-swap: checks owner, status, expiry,
     * idempotency and every cap, then holds the budget. A repeated call with the same idempotency
     * key returns the existing record and never causes a second payment.
     */
    async reserve(
      id: string,
      sid: string,
      key: string,
      payer: string,
      caps: Caps,
    ): Promise<{ replay: boolean; purchase: Purchase }> {
      if (!io.durable)
        throw new ResearchError(
          "STORAGE_UNAVAILABLE",
          "Durable payment storage is not configured. Nothing was paid.",
          503,
        );
      return update((s) => {
        const p = owned(s, id, sid);
        if (p.status === "expired")
          throw new ResearchError("EXPIRED", "Research quote expired. Nothing was paid.", 410);
        if (p.status !== "quoted") {
          if (p.idempotency_key === key) return { replay: true, purchase: { ...p } };
          throw new ResearchError(
            "ALREADY_HANDLED",
            "This quote was already used. Request a new quote.",
            409,
          );
        }
        const now = Date.now();
        if (now >= p.expires_at) {
          p.status = "expired";
          p.updated_at = now;
          throw new ResearchError("EXPIRED", "Research quote expired. Nothing was paid.", 410);
        }
        const amount = BigInt(p.price_atomic);
        if (amount <= 0n || amount > caps.perRequest)
          throw new ResearchError("OVER_CAP", "Price exceeds the per-request cap.", 429);
        const today = new Date(now).setUTCHours(0, 0, 0, 0);
        let session = 0n;
        let day = 0n;
        for (const q of Object.values(s.purchases)) {
          if (!HOLDING.includes(q.status)) continue;
          const a = BigInt(q.price_atomic);
          if (q.sid === sid) session += a;
          if ((q.reserved_at ?? 0) >= today) day += a;
        }
        if (session + amount > caps.perSession)
          throw new ResearchError(
            "SESSION_CAP",
            "Session research budget reached. Nothing was paid.",
            429,
          );
        if (day + amount > caps.perDay)
          throw new ResearchError(
            "DAILY_CAP",
            "Daily research budget reached. Nothing was paid.",
            429,
          );
        Object.assign(p, {
          status: "reserved",
          idempotency_key: key,
          reserved_at: now,
          payer,
          updated_at: now,
        });
        return { replay: false, purchase: { ...p } };
      });
    },
    /** Conditional transition: applies only while the record is in `from`. Returns null otherwise. */
    async transition(id: string, from: PurchaseStatus[], fields: Partial<Purchase>) {
      return update((s) => {
        const p = s.purchases[id];
        if (!p) throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
        if (!from.includes(p.status)) return null;
        Object.assign(p, fields, { updated_at: Date.now() });
        return { ...p };
      });
    },
  };
}
export type ResearchStore = ReturnType<typeof researchStore>;

/** A send that stalled (crash/timeout) is reported as unknown_pending and never resent. */
export const STALE_SENDING_MS = 2 * 60 * 1000;

function prune(s: State) {
  const now = Date.now();
  for (const p of Object.values(s.purchases)) {
    if (p.status === "quoted" && now >= p.expires_at) {
      p.status = "expired";
      p.updated_at = now;
    }
    if (p.status === "sending" && now - p.updated_at > STALE_SENDING_MS) {
      p.status = "unknown_pending";
      p.error = "Payment outcome unknown after an interrupted request. It will not be resent.";
      p.updated_at = now;
    }
    // Keep money-related records for 7 days (receipt trail and UTC-day caps); unpaid ones for 1 day.
    const keep = HOLDING.includes(p.status) ? 7 * 86400000 : 86400000;
    if (p.updated_at < now - keep) delete s.purchases[p.id];
  }
}

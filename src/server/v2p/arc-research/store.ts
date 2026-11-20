// Research purchase records. Separate from the trading ledger on purpose: nothing here can
// reserve, approve or submit a Gemini order. Hosted: one private Vercel Blob with conditional
// writes. Tests and local runs: in-memory.
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { PaymentRequirement } from "./x402";
import type { GeminiSide } from "./compare";

export type PurchaseStatus =
  | "quoted" // unpaid 402 captured, nothing signed
  | "signing" // approval accepted, nonce reserved, signature may exist
  | "paid" // provider returned data after payment; onchain proof pending
  | "settled_onchain" // Arc receipt shows the exact USDC transfer
  | "unknown_after_sign" // signed, but the paid request failed; check chain, never re-sign
  | "free_no_match" // provider says it does not charge when nothing matches
  | "failed" // refused before signing, or proven unused authorization
  | "expired";

export type Purchase = {
  id: string;
  sid: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  status: PurchaseStatus;
  gemini: GeminiSide;
  query: string;
  resource_url: string;
  requirement: PaymentRequirement;
  payer: string | null;
  eip3009_nonce: string | null;
  valid_before: string | null;
  tx_hash: string | null;
  settlement: unknown;
  response_sha256: string | null;
  http_status: number | null;
  error: string | null;
  settled_at: number | null;
  block_number: number | null;
};

type State = { version: 1; purchases: Record<string, Purchase> };
const empty = (): State => ({ version: 1, purchases: {} });

export type StoreIO = {
  /**
   * True only for storage shared by every server instance with conditional writes (Vercel Blob).
   * Real payments require it: the daily cap, nonce uniqueness and single-signature guarantees are
   * only as strong as the store. In-memory storage is per process and never durable.
   */
  readonly durable: boolean;
  read(): Promise<{ state: State; etag?: string } | null>;
  write(state: State, etag?: string): Promise<boolean>;
  putResponse(id: string, body: string): Promise<void>;
  getResponse(id: string): Promise<string | null>;
};

const PATH = "arc-research/v1/purchases.json";

export const blobIO: StoreIO = {
  durable: true,
  async read() {
    const blob = await get(PATH, {
      access: "private",
      useCache: false,
      headers: { "Accept-Encoding": "identity" },
    });
    if (!blob) return null;
    if (blob.statusCode !== 200 || !blob.blob.etag)
      throw new Error("Research store read unavailable");
    const state = (await new Response(blob.stream).json()) as State;
    if (state.version !== 1 || !state.purchases) throw new Error("Invalid research store");
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
  async putResponse(id, body) {
    await put(`arc-research/v1/responses/${id}.json`, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
    });
  },
  async getResponse(id) {
    const blob = await get(`arc-research/v1/responses/${id}.json`, {
      access: "private",
      useCache: false,
    });
    if (!blob || blob.statusCode !== 200) return null;
    return new Response(blob.stream).text();
  },
};

/** Per-process storage for quotes, local runs and tests. Never durable: approval refuses to pay with it. */
export function memoryIO(): StoreIO & { responses: Map<string, string> } {
  let snap: { state: State; etag: string } | null = null;
  let n = 0;
  const responses = new Map<string, string>();
  return {
    durable: false,
    responses,
    async read() {
      return snap ? { state: structuredClone(snap.state), etag: snap.etag } : null;
    },
    async write(state, etag) {
      if ((snap?.etag ?? undefined) !== etag) return false;
      snap = { state: structuredClone(state), etag: String(++n) };
      return true;
    },
    async putResponse(id, body) {
      if (!responses.has(id)) responses.set(id, body);
    },
    async getResponse(id) {
      return responses.get(id) ?? null;
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

const SPENDING: PurchaseStatus[] = ["signing", "paid", "settled_onchain", "unknown_after_sign"];

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
    throw new ResearchError("BUSY", "Research service busy. Try again.", 503);
  }
  return {
    io,
    async insertQuote(
      p: Omit<
        Purchase,
        | "id"
        | "created_at"
        | "updated_at"
        | "status"
        | "payer"
        | "eip3009_nonce"
        | "valid_before"
        | "tx_hash"
        | "settlement"
        | "response_sha256"
        | "http_status"
        | "error"
        | "settled_at"
        | "block_number"
      >,
    ) {
      const id = crypto.randomUUID();
      const now = Date.now();
      await update((s) => {
        s.purchases[id] = {
          ...p,
          id,
          created_at: now,
          updated_at: now,
          status: "quoted",
          payer: null,
          eip3009_nonce: null,
          valid_before: null,
          tx_hash: null,
          settlement: null,
          response_sha256: null,
          http_status: null,
          error: null,
          settled_at: null,
          block_number: null,
        };
      });
      return id;
    },
    async get(id: string) {
      return (await io.read())?.state.purchases[id] ?? null;
    },
    /**
     * The only transition into spending. Atomic: checks owner, expiry, status and the daily cap,
     * then reserves a fresh unique nonce. Returns null when this call did not win the transition,
     * so callers never sign twice.
     */
    async beginSigning(
      id: string,
      sid: string,
      payer: string,
      nonce: string,
      validBefore: string,
      maxPerDayAtomic: bigint,
    ) {
      return update((s) => {
        const p = s.purchases[id];
        if (!p || p.sid !== sid)
          throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
        if (p.status !== "quoted") return null;
        if (Date.now() >= p.expires_at) {
          p.status = "expired";
          p.updated_at = Date.now();
          return null;
        }
        for (const q of Object.values(s.purchases))
          if (q.eip3009_nonce === nonce)
            throw new ResearchError("NONCE_REUSE", "Nonce collision.", 500);
        const today = new Date().setUTCHours(0, 0, 0, 0);
        let spent = 0n;
        for (const q of Object.values(s.purchases))
          if (SPENDING.includes(q.status) && q.updated_at >= today)
            spent += BigInt(q.requirement.amount);
        if (spent + BigInt(p.requirement.amount) > maxPerDayAtomic)
          throw new ResearchError("DAILY_CAP", "Daily research budget reached.", 429);
        Object.assign(p, {
          status: "signing",
          payer,
          eip3009_nonce: nonce,
          valid_before: validBefore,
          updated_at: Date.now(),
        });
        return { ...p };
      });
    },
    async patch(id: string, fields: Partial<Purchase>) {
      return update((s) => {
        const p = s.purchases[id];
        if (!p) throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
        Object.assign(p, fields, { updated_at: Date.now() });
        return { ...p };
      });
    },
    /** Conditional transition: applies only while the purchase is still in `expected`. */
    async patchIf(id: string, expected: PurchaseStatus, fields: Partial<Purchase>) {
      return update((s) => {
        const p = s.purchases[id];
        if (!p) throw new ResearchError("NOT_FOUND", "Research quote not found.", 404);
        if (p.status !== expected) return null;
        Object.assign(p, fields, { updated_at: Date.now() });
        return { ...p };
      });
    },
    async recent(sid: string, limit = 5) {
      const s = (await io.read())?.state ?? empty();
      return Object.values(s.purchases)
        .filter((p) => p.sid === sid)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
    },
  };
}
export type ResearchStore = ReturnType<typeof researchStore>;

function prune(s: State) {
  const now = Date.now();
  for (const p of Object.values(s.purchases)) {
    if (p.status === "quoted" && now >= p.expires_at) {
      p.status = "expired";
      p.updated_at = now;
    }
    // Keep spending records 7 days for the receipt trail; drop stale unpaid quotes after 1 day.
    const keep =
      SPENDING.includes(p.status) || p.status === "free_no_match" ? 7 * 86400000 : 86400000;
    if (p.updated_at < now - keep) delete s.purchases[p.id];
  }
}

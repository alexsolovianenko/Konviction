// Transport-agnostic JSON-RPC helper for DEX research. Every body is built here from a method and
// params, checked against the chain's allowlist BEFORE it is sent, and the call budget is enforced
// before the transport is touched. The transport (paid QuickNode x402 or a test double) only ever
// receives allowlisted bodies.

export type Send = (body: string) => Promise<{ status: number; text: string }>;

export class RpcFailure extends Error {
  constructor(
    public kind: "budget" | "refused" | "transport" | "http" | "rpc" | "parse" | "size",
    message: string,
  ) {
    super(message);
  }
}

export type Flavor = "jsonrpc" | "xrpl";
export type Rpc = (method: string, params: unknown) => Promise<unknown>;

export function makeRpc(opts: {
  flavor: Flavor;
  send: Send;
  allowed: (method: string, params: unknown) => boolean;
  maxCalls: number;
}): { rpc: Rpc; used: () => number } {
  let used = 0;
  const rpc: Rpc = async (method, params) => {
    if (!opts.allowed(method, params))
      throw new RpcFailure("refused", `Method ${method} with these params is not allowlisted.`);
    if (used >= opts.maxCalls) throw new RpcFailure("budget", "Paid call budget reached.");
    used++;
    const body =
      opts.flavor === "xrpl"
        ? JSON.stringify({ method, params: [params] })
        : JSON.stringify({ jsonrpc: "2.0", id: used, method, params });
    let res;
    try {
      res = await opts.send(body);
    } catch (e) {
      if (e instanceof RpcFailure) throw e;
      throw new RpcFailure(
        "transport",
        String((e as Error)?.message ?? "request failed").slice(0, 160),
      );
    }
    if (res.status !== 200) throw new RpcFailure("http", `HTTP ${res.status}`);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      throw new RpcFailure("parse", "Response was not JSON (it may have been truncated).");
    }
    if (j["error"]) {
      const e = (typeof j["error"] === "object" ? j["error"] : { message: j["error"] }) as Record<
        string,
        unknown
      >;
      throw new RpcFailure(
        "rpc",
        `JSON-RPC error ${String(e["code"] ?? "")} ${String(e["message"] ?? "").slice(0, 120)}`.trim(),
      );
    }
    if (!("result" in j)) throw new RpcFailure("parse", "JSON-RPC response had no result.");
    const result = j["result"];
    if (opts.flavor === "xrpl") {
      const r = (result ?? {}) as Record<string, unknown>;
      if (r["status"] === "error")
        throw new RpcFailure("rpc", `XRPL error ${String(r["error"] ?? "").slice(0, 80)}`);
    }
    return result;
  };
  return { rpc, used: () => used };
}

/** Run tasks with bounded concurrency; stops scheduling new tasks once `stop()` is true. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  stop: () => boolean = () => false,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown } | null>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: unknown } | null> = items.map(
    () => null,
  );
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i]!) };
      } catch (error) {
        out[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

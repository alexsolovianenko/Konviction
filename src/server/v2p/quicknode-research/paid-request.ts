// SERVER ONLY. Executes the single paid QuickNode request using the exact flow the owner proved
// manually (createQuicknodeX402Client, nanopayment on Arc Testnet, spend controls, client.fetch),
// plus guards that only narrow what may be signed: a policy and a pre-signing hook that refuse any
// requirement that differs from the approved quote.
import type { ResearchConfig } from "./config";
import { QUICKNODE_BASE_URL } from "./config";
import { sameTerms, validateRequirement, type Requirement } from "./x402";

/** The subset of @quicknode/x402's client this module uses (mockable in tests). */
export type SdkClient = {
  fetch: typeof globalThis.fetch;
  x402Client: {
    setSpendControls(controls: unknown): unknown;
    registerPolicy(
      policy: (
        version: number,
        reqs: Array<Record<string, unknown>>,
      ) => Array<Record<string, unknown>>,
    ): unknown;
    onBeforePaymentCreation(
      hook: (ctx: {
        selectedRequirements: Record<string, unknown>;
      }) => Promise<void | { abort: true; reason: string }>,
    ): unknown;
    onAfterPaymentCreation(hook: (ctx: unknown) => Promise<void>): unknown;
  };
  gatewayClient?: { getBalances(): Promise<{ gateway: { available: bigint } }> } | undefined;
};
export type SdkFactory = (config: {
  baseUrl: string;
  network: string;
  evmPrivateKey: `0x${string}`;
  paymentModel: "nanopayment";
}) => Promise<SdkClient>;

export const defaultSdkFactory: SdkFactory = async (config) => {
  const { createQuicknodeX402Client } = await import("@quicknode/x402");
  return (await createQuicknodeX402Client(config)) as unknown as SdkClient;
};

export type PaidOutcome<T = unknown> = {
  /** At least one payment payload was created (signed) by the SDK. If true, money may have moved. */
  signed: boolean;
  /** Payment payloads created. Each one may have been charged, whether or not data came back. */
  signedCount: number;
  /** Requests sent to QuickNode (paid or not) and how many returned HTTP 200. */
  callsSent: number;
  callsOk: number;
  /** The last HTTP response, for evidence. */
  response: { status: number; text: string; headers: Headers } | null;
  /** SHA-256 over the concatenated per-call response hashes, in call order. */
  responsesSha256: string | null;
  /** First transport-level failure (network error or timeout), if any. */
  error: string | null;
  apiMs: number | null;
  availableBefore: bigint | null;
  availableAfter: bigint | null;
  result: T | null;
};

/** Per paid call; the whole session is also bounded so a voice webhook (60 s) gets an answer. */
const CALL_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 45_000;
/** Largest single JSON-RPC response read (an XRPL account_tx page is ~2 MB). Larger is refused. */
export const MAX_BODY = 8 * 1024 * 1024;
const asRequirement = (r: Record<string, unknown>): Requirement | null => {
  const extra = (r["extra"] ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const [scheme, network, amount, payTo, asset] = [
    s(r["scheme"]),
    s(r["network"]),
    s(r["amount"]),
    s(r["payTo"]),
    s(r["asset"]),
  ];
  if (!scheme || !network || !amount || !payTo || !asset || !/^\d{1,30}$/.test(amount)) return null;
  return {
    scheme,
    network,
    amount,
    payTo,
    asset,
    maxTimeoutSeconds:
      typeof r["maxTimeoutSeconds"] === "number" ? (r["maxTimeoutSeconds"] as number) : null,
    extra: {
      name: s(extra["name"]),
      version: s(extra["version"]),
      verifyingContract: s(extra["verifyingContract"]),
    },
  };
};

/** Requirement is acceptable only if it passes validation AND matches the approved quote. */
function allowed(raw: Record<string, unknown>, quoted: Requirement, cfg: ResearchConfig): boolean {
  const r = asRequirement(raw);
  if (!r) return false;
  try {
    validateRequirement(r, cfg, null, null);
  } catch {
    return false;
  }
  return sameTerms(r, quoted);
}

async function balance(client: SdkClient): Promise<bigint | null> {
  try {
    const b = await Promise.race([
      client.gatewayClient?.getBalances(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 8000)),
    ]);
    const v = b?.gateway?.available;
    return typeof v === "bigint" ? v : null;
  } catch {
    return null;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const redact = (e: unknown) =>
  String((e as Error)?.message ?? "request failed")
    .replace(/0x[0-9a-fA-F]{64,}/g, "[redacted]")
    .slice(0, 200);

/**
 * One approved research request = a bounded session of paid calls to ONE fixed QuickNode URL.
 * `beforeSend` must durably record that payment is about to be attempted; if it throws, nothing is sent.
 * Every body must pass `allowBody`; at most `maxCalls` requests are sent and at most `maxCalls`
 * payments may be created, each no larger than the approved per-call quote. Never retries a call.
 */
export async function runPaidSession<T>(args: {
  cfg: ResearchConfig;
  key: `0x${string}`;
  /** Approved per-call requirement. */
  quoted: Requirement;
  /** Fixed route URL from routes.ts, as stored with the approved quote. */
  url: string;
  maxCalls: number;
  allowBody: (body: string) => boolean;
  factory: SdkFactory;
  beforeSend: () => Promise<void>;
  work: (send: (body: string) => Promise<{ status: number; text: string }>) => Promise<T>;
}): Promise<PaidOutcome<T>> {
  const { cfg, key, quoted } = args;
  const client = await args.factory({
    baseUrl: QUICKNODE_BASE_URL,
    network: cfg.network,
    evmPrivateKey: key,
    paymentModel: "nanopayment",
  });
  const cap = BigInt(quoted.amount) < cfg.maxPerRequest ? BigInt(quoted.amount) : cfg.maxPerRequest;
  client.x402Client.setSpendControls({
    allowedAssets: [
      { network: cfg.network, asset: cfg.asset, maxAmountPerPayment: cap.toString() },
    ],
  });
  client.x402Client.registerPolicy((_v, reqs) => reqs.filter((r) => allowed(r, quoted, cfg)));
  let authorized = 0;
  let signedCount = 0;
  client.x402Client.onBeforePaymentCreation(async (ctx) => {
    if (!allowed(ctx.selectedRequirements, quoted, cfg))
      return { abort: true, reason: "Requirement differs from approved quote" };
    if (authorized >= args.maxCalls) return { abort: true, reason: "Approved call budget reached" };
    authorized++;
    return undefined;
  });
  client.x402Client.onAfterPaymentCreation(async () => {
    signedCount++;
  });

  const availableBefore = await balance(client);
  await args.beforeSend();
  const t0 = Date.now();
  const deadline = t0 + SESSION_TIMEOUT_MS;
  let callsSent = 0;
  let callsOk = 0;
  let response: PaidOutcome["response"] = null;
  let error: string | null = null;
  const hashes: string[] = [];

  const send = async (body: string) => {
    if (!args.allowBody(body)) throw new Error("Body is not allowlisted");
    if (callsSent >= args.maxCalls) throw new Error("Approved call budget reached");
    if (Date.now() > deadline) throw new Error("Research time budget reached");
    callsSent++;
    try {
      const res = await Promise.race([
        client.fetch(args.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          redirect: "manual",
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("QuickNode request timed out")), CALL_TIMEOUT_MS),
        ),
      ]);
      const raw = await res.text();
      const text = raw.length > MAX_BODY ? raw.slice(0, MAX_BODY) : raw;
      response = { status: res.status, text: "", headers: res.headers };
      hashes.push(await sha256Hex(text));
      if (res.status === 200) callsOk++;
      return { status: res.status, text };
    } catch (e) {
      error ??= redact(e);
      throw new Error(redact(e));
    }
  };

  let result: T | null = null;
  try {
    result = await args.work(send);
  } catch (e) {
    error ??= redact(e);
  }
  const apiMs = Date.now() - t0;
  const availableAfter = signedCount ? await balance(client) : availableBefore;
  return {
    signed: signedCount > 0,
    signedCount,
    callsSent,
    callsOk,
    response,
    responsesSha256: hashes.length ? await sha256Hex(hashes.join("")) : null,
    error,
    apiMs,
    availableBefore,
    availableAfter,
    result,
  };
}

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

export type PaidOutcome = {
  /** A payment payload was created (signed) by the SDK. If true, money may have moved. */
  signed: boolean;
  response: { status: number; text: string; headers: Headers } | null;
  error: string | null;
  apiMs: number | null;
  availableBefore: bigint | null;
  availableAfter: bigint | null;
};

const PAID_TIMEOUT_MS = 30_000;
const MAX_BODY = 512 * 1024;

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

/**
 * `beforeSend` must durably record that payment is about to be attempted; if it throws, nothing is sent.
 * Never retries: one call = at most one paid request.
 */
export async function runPaidRequest(args: {
  cfg: ResearchConfig;
  key: `0x${string}`;
  quoted: Requirement;
  /** Fixed route URL and JSON-RPC body from routes.ts, as stored with the approved quote. */
  url: string;
  body: string;
  factory: SdkFactory;
  beforeSend: () => Promise<void>;
}): Promise<PaidOutcome> {
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
  let signed = false;
  client.x402Client.onBeforePaymentCreation(async (ctx) =>
    allowed(ctx.selectedRequirements, quoted, cfg)
      ? undefined
      : { abort: true, reason: "Requirement differs from approved quote" },
  );
  client.x402Client.onAfterPaymentCreation(async () => {
    signed = true;
  });

  const availableBefore = await balance(client);
  await args.beforeSend();
  const t0 = Date.now();
  let response: PaidOutcome["response"] = null;
  let error: string | null = null;
  try {
    const res = await Promise.race([
      client.fetch(args.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: args.body,
        redirect: "manual",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("QuickNode request timed out")), PAID_TIMEOUT_MS),
      ),
    ]);
    const text = (await res.text()).slice(0, MAX_BODY);
    response = { status: res.status, text, headers: res.headers };
  } catch (e) {
    // Only a bounded, non-secret description is kept.
    error = String((e as Error)?.message ?? "request failed")
      .replace(/0x[0-9a-fA-F]{64,}/g, "[redacted]")
      .slice(0, 200);
  }
  const apiMs = Date.now() - t0;
  const availableAfter = signed ? await balance(client) : availableBefore;
  return { signed, response, error, apiMs, availableBefore, availableAfter };
}

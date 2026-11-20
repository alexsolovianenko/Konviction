// Onchain proof: a purchase is only "settled_onchain" after the Arc receipt shows
// a successful USDC Transfer(from = research wallet, to = payTo, value = quoted amount).
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type VerifyInput = {
  rpcUrl: string;
  txHash: string;
  asset: string;
  from: string;
  to: string;
  amount: string;
};
export type VerifyResult =
  | { status: "settled_onchain"; blockNumber: number; logIndex: number }
  | { status: "pending"; reason: string }
  | { status: "mismatch"; reason: string };

const topicAddr = (t: string | undefined) => (t ? "0x" + t.slice(-40).toLowerCase() : "");

export async function verifyTransfer(
  input: VerifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash))
    return { status: "mismatch", reason: "Invalid transaction hash." };
  let res: Response;
  try {
    res = await fetchImpl(input.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [input.txHash],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return {
      status: "pending",
      reason: "Arc RPC unreachable: " + String((e as Error)?.message ?? e),
    };
  }
  if (!res.ok) return { status: "pending", reason: `Arc RPC HTTP ${res.status}` };
  const body = (await res.json().catch(() => null)) as {
    result?: Receipt | null;
    error?: { message?: string };
  } | null;
  if (body?.error)
    return { status: "pending", reason: "Arc RPC error: " + (body.error.message ?? "unknown") };
  const r = body?.result;
  if (!r) return { status: "pending", reason: "Transaction not yet mined." };
  if (r.status !== "0x1") return { status: "mismatch", reason: "Transaction reverted." };
  const want = {
    asset: input.asset.toLowerCase(),
    from: input.from.toLowerCase(),
    to: input.to.toLowerCase(),
    value: BigInt(input.amount),
  };
  for (const log of r.logs ?? []) {
    if (String(log.address).toLowerCase() !== want.asset || log.topics?.[0] !== TRANSFER_TOPIC)
      continue;
    if (topicAddr(log.topics[1]) !== want.from || topicAddr(log.topics[2]) !== want.to) continue;
    if (BigInt(log.data || "0x0") !== want.value) continue;
    return {
      status: "settled_onchain",
      blockNumber: Number(BigInt(r.blockNumber)),
      logIndex: Number(BigInt(log.logIndex ?? "0x0")),
    };
  }
  return { status: "mismatch", reason: "No matching USDC transfer in the receipt." };
}

/**
 * EIP-3009 authorizationState(authorizer, nonce). true = the signed authorization was consumed
 * onchain (money moved), false = not used yet. Used when a paid request failed after signing.
 */
export async function authorizationUsed(
  { rpcUrl, asset, from, nonce }: { rpcUrl: string; asset: string; from: string; nonce: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  // selector = keccak256("authorizationState(address,bytes32)")[0..4]
  const data =
    "0xe94a0102" +
    from.toLowerCase().replace(/^0x/, "").padStart(64, "0") +
    nonce.replace(/^0x/, "");
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: asset, data }, "latest"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: string };
    if (
      typeof body.result !== "string" ||
      !/^0x[0-9a-fA-F]*$/.test(body.result) ||
      body.result.length < 3
    )
      return null;
    return BigInt(body.result) !== 0n;
  } catch {
    return null;
  }
}

type Receipt = {
  status: string;
  blockNumber: string;
  logs?: { address: string; topics?: string[]; data?: string; logIndex?: string }[];
};

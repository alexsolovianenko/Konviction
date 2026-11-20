// SERVER ONLY. The only place that reads the research wallet key. The key never leaves this
// process: it is not logged, returned, stored, or passed anywhere except the QuickNode SDK factory.
import { env } from "../util";

export type ResearchWallet = { key: `0x${string}`; address: string };

const KEY = /^0x[0-9a-fA-F]{64}$/;

/** True when a well-formed key is present. Does not reveal or derive anything. */
export const walletConfigured = () => KEY.test((env("RESEARCH_WALLET_PRIVATE_KEY") ?? "").trim());

export async function loadResearchWallet(): Promise<ResearchWallet | null> {
  const key = (env("RESEARCH_WALLET_PRIVATE_KEY") ?? "").trim();
  if (!KEY.test(key)) return null;
  const { createEvmSigners } = await import("@quicknode/x402");
  const { address } = createEvmSigners(key as `0x${string}`);
  return { key: key as `0x${string}`, address: address.toLowerCase() };
}

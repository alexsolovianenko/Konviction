// Server-only research wallet. The private key is read from env at call time and never returned,
// logged or sent to the client. Only the address leaves this module.
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { env } from "../util";

export function researchAccount(): LocalAccount | null {
  const key = env("ARC_RESEARCH_PRIVATE_KEY");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`);
}

export const researchAddress = (): string | null => researchAccount()?.address ?? null;

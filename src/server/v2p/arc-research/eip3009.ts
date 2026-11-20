// EIP-3009 TransferWithAuthorization signing for one x402 "exact" payment.
// The signer is injected so tests can use a throwaway key and the server key never leaves wallet.ts.
import type { Hex, LocalAccount } from "viem";
import { chainIdOf } from "./config";
import type { PaymentRequirement } from "./x402";

export const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export type Authorization = {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export function buildAuthorization(
  account: { address: Hex },
  req: PaymentRequirement,
  nonce: Hex,
  nowSec: number,
): Authorization {
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("nonce must be 32 bytes");
  return {
    from: account.address,
    to: req.payTo as Hex,
    value: req.amount,
    validAfter: "0",
    validBefore: String(nowSec + Math.min(req.maxTimeoutSeconds || 300, 300)),
    nonce,
  };
}

export async function signAuthorization(
  account: LocalAccount,
  req: PaymentRequirement,
  auth: Authorization,
): Promise<Hex> {
  const chainId = chainIdOf(req.network);
  if (!chainId) throw new Error("Unsupported network " + req.network);
  return account.signTypedData({
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId,
      verifyingContract: req.asset as Hex,
    },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
}

/** x402 v2 PAYMENT-SIGNATURE payload. */
export const paymentPayload = (
  req: PaymentRequirement,
  signature: Hex,
  authorization: Authorization,
  resource?: unknown,
) => ({
  x402Version: 2,
  ...(resource ? { resource } : {}),
  accepted: req,
  payload: { signature, authorization },
});

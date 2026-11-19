// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Tamper-evident receipts: canonical JSON -> sha256 -> Solana devnet Memo transaction.
// Receipts prove what we recorded and when. Gemini's API remains the source of truth for execution.
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { db } from "./db";
import { canonical, env, sha256Hex } from "./util";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const rpc = () => env("SOLANA_RPC_URL") ?? "https://api.devnet.solana.com";

/** Devnet-only signing key. Generated once and kept in the settings table (service-role only). */
export async function receiptKeypair(): Promise<Keypair> {
  const envKey = env("SOLANA_RECEIPT_SECRET_KEY");
  if (envKey) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envKey)));
  const { data } = await db.from("settings").select("value").eq("key", "solana_receipt_key").maybeSingle();
  if (data?.value) return Keypair.fromSecretKey(Uint8Array.from(data.value as number[]));
  const kp = Keypair.generate();
  await db.from("settings").insert({ key: "solana_receipt_key", value: Array.from(kp.secretKey) });
  // Re-read in case another instance won the race.
  const { data: again } = await db.from("settings").select("value").eq("key", "solana_receipt_key").maybeSingle();
  return Keypair.fromSecretKey(Uint8Array.from(again!.value as number[]));
}

export async function receiptAddress(): Promise<string> {
  return (await receiptKeypair()).publicKey.toBase58();
}

export async function receiptBalanceSol(): Promise<number | null> {
  try {
    const conn = new Connection(rpc(), "confirmed");
    return (await conn.getBalance((await receiptKeypair()).publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}

/** Insert the receipt row immediately; anchor on Solana afterwards (call inside background()). */
export async function createReceipt(intentId: string, code: string, kind: "approval" | "result", payload: Record<string, unknown>) {
  const payloadText = canonical({ v: 1, app: "voice-to-predict", env: "gemini-sandbox", kind, intent_code: code, ...payload });
  const sha = await sha256Hex(payloadText);
  const { data: row, error } = await db.from("receipts")
    .insert({ intent_id: intentId, kind, payload_text: payloadText, sha256: sha })
    .select("id").single();
  if (error) throw error;
  return { id: row.id as string, sha, anchor: () => anchor(row.id as string, `v2p:${code}:${kind}:${sha}`) };
}

async function anchor(receiptId: string, memo: string) {
  try {
    const kp = await receiptKeypair();
    const conn = new Connection(rpc(), "confirmed");
    const bal = await conn.getBalance(kp.publicKey);
    if (bal < 0.001 * LAMPORTS_PER_SOL) {
      try {
        const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
        await conn.confirmTransaction(sig, "confirmed");
      } catch (e) {
        throw new Error(`receipt wallet unfunded; fund ${kp.publicKey.toBase58()} at faucet.solana.com (${e})`);
      }
    }
    const tx = new Transaction().add(new TransactionInstruction({
      keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM,
      data: Buffer.from(memo, "utf8"),
    }));
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
    await db.from("receipts").update({ solana_sig: sig, error: null }).eq("id", receiptId);
  } catch (e) {
    await db.from("receipts").update({ error: String(e).slice(0, 500) }).eq("id", receiptId);
  }
}

/** Anchor up to `max` unanchored receipts. Each row is claimed atomically first so concurrent callers never double-anchor. */
export async function anchorPending(max = 2): Promise<void> {
  const retryable = "error.is.null,error.like.receipt wallet unfunded*";
  const { data } = await db.from("receipts").select("id,intent_id,kind,sha256")
    .is("solana_sig", null).or(retryable).order("created_at", { ascending: true }).limit(max);
  for (const r of data ?? []) {
    const { data: claimed } = await db.from("receipts").update({ error: "anchoring…" })
      .eq("id", r.id).is("solana_sig", null).or(retryable).select("id");
    if (!claimed || claimed.length === 0) continue;
    const { data: it } = await db.from("intents").select("code").eq("id", r.intent_id).maybeSingle();
    await anchor(r.id, `v2p:${it?.code ?? "unknown"}:${r.kind}:${r.sha256}`);
  }
}

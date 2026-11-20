import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// One private sandbox account per enrolled subscriber. Never mutate process.env per request.
export interface PhoneAccount {
  id: string;
  phone: string;
  apiKey: string;
  apiSecret: string;
  totpSecret: string;
  notifySince?: string;
}
export const phoneAccount = new AsyncLocalStorage<PhoneAccount>();
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function accounts(): PhoneAccount[] {
  let rows: PhoneAccount[];
  try {
    rows = JSON.parse(process.env["PHONE_ACCOUNTS_JSON"] || "[]");
  } catch {
    throw Error("Invalid phone enrollment: malformed JSON");
  }
  if (!Array.isArray(rows)) throw Error("Invalid phone account configuration");
  for (const row of rows) {
    // Diagnostic messages contain field names only. Never log enrollment values.
    if (!row || !/^[a-z0-9-]{1,64}$/.test(row.id)) throw Error("Invalid phone enrollment: id");
    if (typeof row.phone === "string") {
      const digits = row.phone.replace(/[ ()-]/g, "");
      if (/^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/.test(digits)) row.phone = "+1" + digits.slice(-10);
    }
    if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(row.phone))
      throw Error("Invalid phone enrollment: phone");
    if (typeof row.apiKey !== "string" || !row.apiKey.trim() || row.apiKey.startsWith("<"))
      throw Error("Invalid phone enrollment: apiKey");
    if (row.apiKey === process.env["GEMINI_API_KEY"])
      throw Error("Invalid phone enrollment: shared demo API key");
    if (typeof row.apiSecret !== "string" || !row.apiSecret.trim() || row.apiSecret.startsWith("<"))
      throw Error("Invalid phone enrollment: apiSecret");
    if (!/^[A-Z2-7]{32}$/.test(row.totpSecret)) throw Error("Invalid phone enrollment: totpSecret");
    if (row.notifySince !== undefined && !Number.isFinite(Date.parse(row.notifySince)))
      throw Error("Invalid phone enrollment: notifySince");
  }
  for (const key of ["id", "phone", "apiKey", "totpSecret"] as const)
    if (new Set(rows.map((row) => row[key])).size !== rows.length)
      throw Error("Duplicate phone enrollment");
  return rows;
}

export function verifyCode(base32: string, code: unknown, now: number): number | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const bits = [...base32]
    .map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hash = createHmac("sha1", key).update(counter).digest();
    const n = (hash.readUInt32BE(hash[19]! & 15) & 0x7fffffff) % 1000000;
    if (timingSafeEqual(Buffer.from(String(n).padStart(6, "0")), Buffer.from(code))) return step;
  }
  return null;
}

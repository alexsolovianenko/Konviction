import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

// One private sandbox account per enrolled subscriber. Never mutate process.env per request.
export interface PhoneAccount {
  id: string;
  phone: string;
  apiKey: string;
  apiSecret: string;
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
    if (row.notifySince !== undefined && !Number.isFinite(Date.parse(row.notifySince)))
      throw Error("Invalid phone enrollment: notifySince");
  }
  for (const key of ["id", "phone", "apiKey"] as const)
    if (new Set(rows.map((row) => row[key])).size !== rows.length)
      throw Error("Duplicate phone enrollment");
  return rows;
}

// Only credentials explicitly designated for the public sandbox demo may be used on inbound calls.
export function phoneDemoAccount(): PhoneAccount | null {
  const sharedDemo = process.env["PHONE_SANDBOX_ACCOUNT"] === "website-demo";
  const apiKey = process.env[sharedDemo ? "GEMINI_API_KEY" : "PHONE_DEMO_GEMINI_API_KEY"];
  const apiSecret = process.env[sharedDemo ? "GEMINI_API_SECRET" : "PHONE_DEMO_GEMINI_API_SECRET"];
  if (!apiKey?.trim() || !apiSecret?.trim()) return null;
  return { id: sharedDemo ? "_website-demo" : "_phone-demo", phone: "", apiKey, apiSecret };
}

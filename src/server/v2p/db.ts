// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Port note: uses the project's generated service-role client (server-only, lazily created from
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) instead of a hand-built createClient.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { env } from "./util";

export const db = supabaseAdmin;

export async function logActivity(kind: string, caller: string | null, summary: string, detail?: unknown) {
  const { error } = await db.from("activity").insert({ kind, caller, summary, detail: detail ?? null });
  if (error) console.error("activity insert failed", error);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

/**
 * Fail closed: orders are sent only when the EXECUTION_ENABLED secret is explicitly "true"
 * AND the settings kill switch is not false. A missing or misspelled secret disables trading.
 */
export async function executionEnabled(): Promise<boolean> {
  if ((env("EXECUTION_ENABLED") ?? "").trim().toLowerCase() !== "true") return false;
  return (await getSetting<boolean>("execution_enabled", false)) === true;
}

export async function touchCaller(phone: string): Promise<{ returning: boolean; callCount: number }> {
  const { data } = await db.from("callers").select("*").eq("phone", phone).maybeSingle();
  if (!data) {
    await db.from("callers").insert({ phone, call_count: 1 });
    return { returning: false, callCount: 1 };
  }
  const callCount = (data.call_count ?? 0) + 1;
  await db.from("callers").update({ last_seen: new Date().toISOString(), call_count: callCount }).eq("phone", phone);
  return { returning: true, callCount };
}

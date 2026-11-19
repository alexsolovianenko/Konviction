// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Public read-only state for the judge dashboard. Polled every ~2.5 s.
// Returns DB activity plus a live (cached 5 s) snapshot of the Gemini sandbox account.
import { liveAccount } from "./account-summary";
import { dashboardMarkets } from "./dashboard-markets";
import { db, executionEnabled } from "./db";
import { receiptAddress, receiptBalanceSol } from "./receipts";
import { corsHeaders, env, json, LIMITS, maskPhone } from "./util";

// Bump on every backend change so the deployed revision can be checked read-only from the dashboard feed.
export const BACKEND_REVISION = "2026-11-19.3-browser-voice-approval";

async function readLocalAccount() {
  try {
    const capturePort = env("CAPTURE_PORT");
    if (!capturePort) return await liveAccount();
    // Dashboard polling and voice trades share one signer in the local API process.
    const response = await fetch("http://127.0.0.1:" + capturePort + "/internal/account-summary");
    if (!response.ok) throw new Error("Account unavailable");
    return await response.json();
  } catch {
    return { configured: true, terms_accepted: null, balance_error: "Gemini account data unavailable.", positions_error: "Gemini position data unavailable." };
  }
}

let solana: { at: number; value: unknown } | null = null;
async function solanaInfo() {
  if (solana && Date.now() - solana.at < 30_000) return solana.value;
  const address = await receiptAddress().catch(() => null);
  const value = { address, balance_sol: await receiptBalanceSol(address) };
  solana = { at: Date.now(), value };
  return value;
}

export async function handleDashboardState(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const local = env("LOCAL_BROWSER_LEDGER") === "sqlite" && ["127.0.0.1","localhost","[::1]"].includes(new URL(req.url).hostname);
  const configured = local && Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
  const columns = {
    activity: "id,at,kind,caller,summary",
    intents: "id,code,caller,side,title,contract_label,instrument_symbol,outcome,quantity,limit_price,notional_usd,est_fee_usd,quote_price,status,expires_at,created_at",
    orders: "id,intent_id,side,gemini_order_id,outcome_summary,exchange_status,filled_qty,remaining_qty,avg_price,created_at",
    receipts: "id,intent_id,kind,payload_text,sha256,solana_sig,created_at",
  };
  const rows = async (table: string, key: string, limit: number) => {
    if (!configured) return { data: [], error: true };
    try { return await db.from(table).select(columns[table]).order(key, { ascending: false }).limit(limit); }
    catch { return { data: [], error: true }; }
  };
  const [act, intents, orders, receipts, account, sol, enabled, markets] = await Promise.all([
    rows("activity", "at", 60),
    rows("intents", "created_at", 25),
    rows("orders", "created_at", 25),
    rows("receipts", "created_at", 30),
    local ? readLocalAccount() : { configured: false },
    local && (configured || env("SOLANA_RECEIPT_SECRET_KEY")) ? solanaInfo().catch(() => null) : null,
    executionEnabled().catch(() => false),
    dashboardMarkets().catch(() => ({ events: [], error: "Gemini Sandbox markets unavailable." })),
  ]);
  const mask = <T extends { caller?: string | null }>(rows: T[] | null) => (rows ?? []).map((r) => ({ ...r, caller: maskPhone(r.caller) }));
  return json({
    generated_at: new Date().toISOString(),
    backend_revision: BACKEND_REVISION,
    environment: "gemini-sandbox (test funds only)",
    phone_number: env("PUBLIC_PHONE_NUMBER") ?? null,
    execution_enabled: enabled,
    limits: LIMITS,
    account,
    solana: sol,
    markets,
    history_available: ![act, intents, orders, receipts].some(r => r.error),
    activity: mask(act.data),
    intents: mask(intents.data),
    orders: orders.data ?? [],
    receipts: receipts.data ?? [],
  });
}

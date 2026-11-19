// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// Public read-only state for the judge dashboard. Polled every ~2.5 s.
// Returns DB activity plus a live (cached 5 s) snapshot of the Gemini sandbox account.
import { geminiReadError, getUsdAvailable, gPrivate, hasCredentials } from "./gemini";
import { dashboardMarkets } from "./dashboard-markets";
import { db, executionEnabled } from "./db";
import { anchorPending, receiptAddress, receiptBalanceSol } from "./receipts";
import { corsHeaders, env, json, LIMITS, maskPhone, num } from "./util";

// Bump on every backend change so the deployed revision can be checked read-only from the dashboard feed.
export const BACKEND_REVISION = "2026-11-19.2-gemini-fetch-workers-fix";

let live: { at: number; value: unknown } | null = null;

async function liveAccount() {
  if (live && Date.now() - live.at < 5000) return live.value;
  if (!hasCredentials()) {
    live = { at: Date.now(), value: { configured: false } };
    return live.value;
  }
  const [terms, bal, pos] = await Promise.all([
    gPrivate("/v1/prediction-markets/terms/status", {}, { method: "GET" }),
    getUsdAvailable(),
    gPrivate("/v1/prediction-markets/positions"),
  ]);
  // deno-lint-ignore no-explicit-any
  const positions = (pos.data?.positions ?? []).filter((p: any) => (num(p.totalQuantity) ?? 0) > 0).map((p: any) => ({
    symbol: p.symbol, outcome: p.outcome, quantity: p.totalQuantity, on_hold: p.quantityOnHold, avg_price: p.avgPrice,
    bid: p.prices?.sell?.[String(p.outcome).toLowerCase()] ?? null, market_value: p.marketValue ?? null,
    unrealized_pnl: p.unrealizedPnl ?? null, event: p.contractMetadata?.eventName, contract: p.contractMetadata?.contractName,
    contract_status: p.contractMetadata?.contractStatus, expiry: p.contractMetadata?.expiryDate, resolution_side: p.resolutionSide ?? null,
  }));
  live = {
    at: Date.now(),
    value: {
      configured: true,
      terms_accepted: terms.ok && typeof terms.data?.hasAcceptedLatest === "boolean" ? terms.data.hasAcceptedLatest : null,
      terms_error: !terms.ok ? geminiReadError(terms) : typeof terms.data?.hasAcceptedLatest !== "boolean" ? "Gemini returned an unexpected terms response." : null,
      usd_available: bal.usd,
      balance_error: bal.error ?? null,
      positions,
      positions_error: pos.ok ? null : geminiReadError(pos),
      raw_positions: pos.ok ? pos.data : null,
    },
  };
  return live.value;
}

let solana: { at: number; value: unknown } | null = null;
async function solanaInfo() {
  if (solana && Date.now() - solana.at < 30_000) return solana.value;
  const value = { address: await receiptAddress().catch(() => null), balance_sol: await receiptBalanceSol() };
  solana = { at: Date.now(), value };
  return value;
}

export async function handleDashboardState(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  await anchorPending(2).catch((e) => console.error("anchorPending failed", e));
  const [act, intents, orders, receipts, account, sol, enabled, markets] = await Promise.all([
    db.from("activity").select("*").order("at", { ascending: false }).limit(60),
    db.from("intents").select("*").order("created_at", { ascending: false }).limit(25),
    db.from("orders").select("*").order("created_at", { ascending: false }).limit(25),
    db.from("receipts").select("*").order("created_at", { ascending: false }).limit(30),
    liveAccount().catch(() => ({ configured: true, terms_accepted: null, balance_error: "Gemini account data unavailable." })),
    solanaInfo().catch(() => null),
    executionEnabled(),
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
    activity: mask(act.data),
    intents: mask(intents.data),
    orders: orders.data ?? [],
    receipts: receipts.data ?? [],
  });
}

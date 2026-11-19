// @ts-nocheck -- mechanical port of the Deno edge-function code; logic kept verbatim.
// ElevenLabs webhook (server) tools for Voice-to-Predict — READ-ONLY and PROPOSAL-ONLY.
// POST /api/public/agent-tools/{find_market|prepare_trade|get_portfolio}
// Header X-Tool-Secret must equal TOOL_SHARED_SECRET (header only; no query-string secret).
// caller / conversation_id come from ElevenLabs dynamic variables, never from the model.
//
// There is deliberately NO execute tool: the language model can never submit an order.
// Orders are submitted only by POST /api/public/browser-trading/approve, which needs a verified
// browser voice session plus a PIN typed on screen.

import {
  contractTradable, getUsdAvailable, gPrivate, listActiveEvents, quoteFor,
  type Contract, type GEvent,
} from "./gemini";
import { fiveMinuteDiscovery, normalizeMarketQuery } from "./prediction-discovery";
import { prepareTrade as prepareQuotedTrade } from "./trade-engine";
import { db, logActivity } from "./db";
import { dailyCapError, supabaseLedger } from "./ledger";
import {
  corsHeaders, json, localHour, LIMITS, minBuyMinutesToExpiry, num, randomCode, speakTime, toolAuthorized,
} from "./util";

// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

function callerOf(b: Body): string {
  const c = String(b.caller ?? b.caller_id ?? "").trim();
  return c && !c.startsWith("{{") ? c : "web";
}
function conversationOf(b: Body): string | null {
  const c = String(b.conversation_id ?? "").trim();
  return c && !c.startsWith("{{") ? c : null;
}
const err = (code: string, message: string, extra: Body = {}) => json({ ok: false, error: code, message, ...extra });

// ---------------------------------------------------------------- find_market

const SYNONYMS: Record<string, string[]> = {
  bitcoin: ["btc", "bitcoin"], btc: ["btc", "bitcoin"],
  ethereum: ["eth", "ethereum", "ether"], ether: ["eth", "ethereum"], eth: ["eth", "ethereum"],
  solana: ["sol", "solana"], sol: ["sol", "solana"],
  gold: ["gold", "xau"], silver: ["silver", "xag"], oil: ["oil", "crude", "wti"],
  doge: ["doge", "dogecoin"], dogecoin: ["doge", "dogecoin"], xrp: ["xrp", "ripple"], ripple: ["xrp", "ripple"],
};
const STOP = new Set([
  "the", "will", "be", "above", "below", "over", "under", "than", "at", "on", "by", "for", "and", "put", "bet",
  "buy", "sell", "dollars", "dollar", "price", "market", "contract", "today", "tomorrow", "tonight", "think", "what",
  "with", "into", "this", "that", "next", "hour", "end", "close", "higher", "lower", "going", "want", "yes", "no",
]);

function parseNumbers(s: string): number[] {
  const out: number[] = [];
  const re = /\$?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand)?/gi;
  for (const m of s.matchAll(re)) {
    let n = Number(m[1].replace(/,/g, ""));
    if (m[2]) n *= 1000;
    if (Number.isFinite(n) && n >= 10) out.push(n); // ignore tiny numbers like "3" in "3pm"
  }
  return out;
}

function parseHourHint(s: string): number | null {
  const m = s.toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].startsWith("p")) h += 12;
  return h;
}

function strikeOf(c: Contract): number | null {
  const v = num(c.strike?.value);
  if (v !== null) return v;
  const m = (c.label ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

async function findMarket(b: Body) {
  const query = String(b.query ?? "").trim();
  if (!query) return err("BAD_INPUT", "Ask the caller what they want to bet on.");
  const expiryHint = String(b.expiry_hint ?? "");
  const normalized = normalizeMarketQuery(query + " " + expiryHint);
  const assets = [...new Set(normalized.match(/\b(?:btc|eth|sol|xrp)\b/g) ?? [])];
  if (assets.length && /\b05m\b/.test(normalized)) {
    try {
      const result = await fiveMinuteDiscovery(assets, normalized);
      const matches = result.events.flatMap(ev => ev.contracts.map(c => {
        const seconds = Math.max(0, (Date.parse(c.expiry) - Date.now()) / 1000);
        return { event_ticker: ev.ticker, event_title: ev.title, contract_label: c.label,
          instrument_symbol: c.symbol, expires_spoken: speakTime(c.expiry), minutes_to_expiry: Math.round(seconds / 60),
          yes_buy_price: c.buy.yes, no_buy_price: c.buy.no, yes_sell_price: c.sell.yes, no_sell_price: c.sell.no,
          tradable_now: seconds >= minBuyMinutesToExpiry(ev.ticker) * 60 && (c.buy.yes !== null || c.buy.no !== null) };
      }));
      return json({ ok: true, matches, none_found: !matches.length, ambiguous: matches.length > 1, timing: result.timing });
    } catch {
      return err("MARKET_DATA_UNAVAILABLE", "Gemini market data is unavailable right now.");
    }
  }
  const { events, error } = await listActiveEvents();
  if (error) return err("MARKET_DATA_UNAVAILABLE", "Gemini market data is unavailable right now. Do not guess prices.", { detail: error });

  const q = `${query} ${expiryHint}`.toLowerCase();
  const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
  const nums = parseNumbers(query);
  const hourHint = parseHourHint(q);
  const wantsSoonest = /\b(next|soonest|nearest|earliest)\b/.test(q);
  const now = Date.now();

  type Cand = { ev: GEvent; c: Contract; score: number; expiryMs: number; strike: number | null };
  const cands: Cand[] = [];
  let closedMatches = 0;
  for (const ev of events) {
    for (const c of ev.contracts ?? []) {
      const hay = [ev.title, ev.ticker, ev.category, ...(ev.subcategory?.path ?? []), c.label, c.ticker, c.instrumentSymbol]
        .filter(Boolean).join(" ").toLowerCase();
      let score = 0;
      for (const w of words) {
        const alts = SYNONYMS[w] ?? [w];
        if (alts.some((a) => new RegExp(`(^|[^a-z])${a}`).test(hay))) score += 2;
      }
      if (score === 0) continue;
      const expiryIso = c.expiryDate ?? ev.expiryDate ?? null;
      const expiryMs = expiryIso ? Date.parse(expiryIso) : Infinity;
      if (!contractTradable(c) || expiryMs <= now) { closedMatches++; continue; }
      const strike = strikeOf(c);
      if (nums.length && strike !== null) {
        const best = Math.min(...nums.map((n) => Math.abs(n - strike) / Math.max(n, 1)));
        score += best < 0.0005 ? 4 : best < 0.01 ? 2.5 : best < 0.05 ? 1 : 0;
      }
      if (hourHint !== null && expiryIso) {
        const lh = localHour(expiryIso);
        if (lh.hour === hourHint && lh.minute === 0) score += 3;
      }
      cands.push({ ev, c, score, expiryMs, strike });
    }
  }

  cands.sort((a, b2) =>
    wantsSoonest ? a.expiryMs - b2.expiryMs || b2.score - a.score : b2.score - a.score || a.expiryMs - b2.expiryMs
  );
  const top = cands.slice(0, 4);
  if (!top.length) {
    return json({
      ok: true, none_found: true,
      message: closedMatches
        ? "Matching contracts exist but none are open for trading right now. Offer the next available one."
        : "No open Gemini contract matches that. Ask the caller to rephrase (e.g. 'Bitcoin above 97,000 at 4 PM').",
    });
  }
  const matches = top.map(({ ev, c, expiryMs }) => {
    const y = quoteFor(c, "yes"), n = quoteFor(c, "no");
    const minutes = Math.round((expiryMs - now) / 60000);
    return {
      event_ticker: ev.ticker,
      event_title: ev.title,
      contract_label: c.label ?? c.abbreviatedName ?? null,
      instrument_symbol: c.instrumentSymbol,
      expires_spoken: speakTime(c.expiryDate ?? ev.expiryDate),
      minutes_to_expiry: minutes,
      yes_buy_price: y.buy, no_buy_price: n.buy, yes_sell_price: y.sell, no_sell_price: n.sell,
      tradable_now: expiryMs - now >= minBuyMinutesToExpiry(ev.ticker) * 60000 && (y.buy !== null || n.buy !== null),
      note: y.buy === null && n.buy === null ? "No one is offering this contract right now (no ask)." : undefined,
    };
  });
  return json({
    ok: true,
    ambiguous: top.length > 1 && top[0] && top[1] && cands[0].score === cands[1].score,
    matches,
    guidance: "Use event titles and contract labels in speech. Keep identifiers in tool arguments. Confirm which contract the caller means before preparing a trade. Prices are in dollars per contract (0.47 = 47 cents). Sandbox prices are test prices, not real market prices.",
  });
}

// ---------------------------------------------------------------- prepare_trade

async function prepareTrade(b: Body) {
  const caller = callerOf(b);
  return prepareQuotedTrade(b, async ({ readback: _displayReadback, ...terms }) => {
    const { side, outcome, quantity, limit_price: limit, notional_usd: notional, est_fee_usd: fee, instrument_symbol: symbol, quote_price: quotePrice } = terms;
    if (side === "buy") {
      // Same account-wide ledger as browser approval (filled + in-flight + unknown reservations).
      const committed = await supabaseLedger.committedUsd();
      if (committed === null) return err("RISK_UNAVAILABLE", "Could not verify the daily sandbox limit.");
      const capErr = dailyCapError(committed, notional + fee);
      if (capErr) return err("CAP_EXCEEDED", capErr);
    }

    // Supersede older proposals for this caller.
    await db.from("intents").update({ status: "SUPERSEDED", updated_at: new Date().toISOString() })
      .eq("caller", caller).eq("status", "PROPOSED");

    const code = randomCode();
    const { error: insErr } = await db.from("intents").insert({ ...terms, code, caller, conversation_id: conversationOf(b) });
    if (insErr) return err("INTERNAL", "Could not save the proposal.");
    await logActivity("INTENT_PROPOSED", caller, `${side.toUpperCase()} ${quantity} ${outcome.toUpperCase()} ${symbol} @ ≤${limit}`, {
      code, side, symbol, outcome, quantity, limit, notional, fee, quote: quotePrice,
    });

    return json({
      ok: true, intent_code: code, side, outcome, quantity, limit_price: limit, notional_usd: notional,
      est_fee_usd: fee, fee_is_estimate: true, current_price: quotePrice, intent_expires_in_s: LIMITS.intentTtlSeconds,
      readback: "Review the proposal on your dashboard.",
      next_step: "Speak only the readback. The dashboard shows the terms for private approval.",
    });
  });
}

// ---------------------------------------------------------------- get_portfolio

async function getPortfolio(_b: Body) {
  const [pos, active, settled, bal] = await Promise.all([
    gPrivate("/v1/prediction-markets/positions"),
    gPrivate("/v1/prediction-markets/orders/active"),
    gPrivate("/v1/prediction-markets/positions/settled", {}, { query: { limit: 5 } }),
    getUsdAvailable(),
  ]);
  if (!pos.ok) return err("EXCHANGE_ERROR", "Couldn't read positions from Gemini right now. Don't guess.", { detail: pos.error ?? pos.text.slice(0, 200) });
  // deno-lint-ignore no-explicit-any
  const positions = (pos.data?.positions ?? []).filter((p: any) => (num(p.totalQuantity) ?? 0) > 0).map((p: any) => {
    const outcome = String(p.outcome ?? "").toLowerCase() as "yes" | "no";
    const bid = num(p.prices?.sell?.[outcome]);
    const meta = p.contractMetadata ?? {};
    return {
      event_title: meta.eventName, contract_label: meta.contractName, event_ticker: meta.eventTicker,
      instrument_symbol: p.symbol, outcome, quantity: num(p.totalQuantity), on_hold: num(p.quantityOnHold),
      avg_price: num(p.avgPrice), current_bid: bid,
      market_value_usd: num(p.marketValue), unrealized_pnl_usd: num(p.unrealizedPnl), // straight from Gemini; absent when Gemini omits it
      contract_status: meta.contractStatus ?? null, expires_spoken: speakTime(meta.expiryDate),
      resolution_side: p.resolutionSide ?? meta.resolutionSide ?? null,
      status_note: meta.expiryDate && Date.parse(meta.expiryDate) < Date.now() && !p.resolutionSide
        ? "Trading has closed; waiting for Gemini to publish the result. Do not say it won or lost." : undefined,
    };
  });
  // deno-lint-ignore no-explicit-any
  const recentSettled = (settled.data?.positions ?? []).slice(0, 5).map((s: any) => ({
    contract_label: s.contractMetadata?.contractName, event_title: s.contractMetadata?.eventName, outcome: s.outcome,
    quantity: num(s.positionQuantity), resolution_side: s.resolutionSide, payout_usd: num(s.payout),
    net_profit_usd: num(s.netProfit), settled_spoken: speakTime(s.settledAt),
  }));
  return json({
    ok: true,
    positions,
    open_orders: (active.data?.orders ?? []).length,
    recent_settlements: recentSettled,
    cash_available_usd: bal.usd,
    note: "Describe positions by event title, contract label and outcome. Never read identifiers aloud. Only speak numbers present here. Settlement is final only if it appears in recent_settlements. Sandbox prices are test prices.",
  });
}

// ---------------------------------------------------------------- router

export async function handleAgentTools(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await toolAuthorized(req))) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  const tool = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  let body: Body = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const started = Date.now();
  try {
    let res: Response;
    switch (tool) {
      case "find_market": res = await findMarket(body); break;
      case "prepare_trade": res = await prepareTrade(body); break;
      case "get_portfolio": res = await getPortfolio(body); break;
      case "execute_trade":
        // Removed on purpose: no voice/LLM tool may submit an order.
        await logActivity("TOOL_EXECUTE_REFUSED", callerOf(body), "execute_trade refused: approval happens only on the dashboard");
        return json({ ok: false, error: "APPROVAL_REQUIRED", message: "Orders can only be approved on the secure dashboard. Nothing was placed." }, 403);
      default: return json({ ok: false, error: "UNKNOWN_TOOL", tool }, 404);
    }
    const out = await res.clone().json().catch(() => null);
    await logActivity("TOOL_" + tool.toUpperCase(), callerOf(body),
      `${tool} → ${out?.error ?? out?.outcome_summary ?? (out?.ok ? "ok" : "?")} (${Date.now() - started} ms)`,
      { ok: out?.ok === true });
    return res;
  } catch (e) {
    console.error(e);
    await logActivity("TOOL_ERROR", callerOf(body), `${tool} unavailable`).catch(() => {});
    return json({ ok: false, error: "INTERNAL", message: "Something went wrong on our side. Don't say whether anything was placed; offer to check the portfolio." }, 200);
  }
}

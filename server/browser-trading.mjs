import { createHash, timingSafeEqual } from "node:crypto";
import { prepareTrade, executeTrade, isValidBuySize } from "../src/server/v2p/trade-engine.ts";
import { gPrivate, hasCredentials } from "../src/server/v2p/gemini.ts";
import { LIMITS } from "../src/server/v2p/util.ts";
import { TradingRepository, TradeError } from "./trading-repository.mjs";

import { TrustedDevices, deviceLifetimeSeconds } from "./trusted-device.mjs";

const keysAre = (obj, keys) =>
  obj &&
  typeof obj === "object" &&
  Object.keys(obj).length === keys.length &&
  keys.every((k) => Object.hasOwn(obj, k));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const symbol = /^[A-Z0-9][A-Z0-9_.-]{0,99}$/;
const hash = (text) => createHash("sha256").update(text).digest();
const bad = () => {
  throw new TradeError("BAD_INPUT", "Invalid trade parameters.", 400);
};
export function availability(voiceAuthorized = false) {
  const missing = [];
  if (!hasCredentials()) missing.push("Gemini sandbox account credentials");
  if (!voiceAuthorized && !/^\d{4,8}$/.test(process.env.DEMO_PIN ?? "")) missing.push("a 4–8 digit server DEMO_PIN");
  if (process.env.EXECUTION_ENABLED !== "true") missing.push("EXECUTION_ENABLED=true");
  return {
    ok: true,
    execution_enabled: !missing.length,
    voice_confirmation_supported: true,
    voice_authorized: voiceAuthorized,
    message: missing.length
      ? "Approval unavailable. Configure " + missing.join(", ") + "."
      : "Sandbox approval is enabled.",
  };
}
function sessionOwner(repo, token) {
  const s = token && repo.authenticate(hash(token).toString("hex"));
  if (!s || s.state !== "active" || Date.now() >= Math.min(s.expires, s.last_seen + 600000))
    throw new TradeError(
      "UNAUTHORIZED",
      "An active authenticated browser voice session is required.",
      401,
    );
  return s.id;
}
function requirePin(store, pin) {
  if (!/^\d{4,8}$/.test(process.env.DEMO_PIN ?? ""))
    throw new TradeError("PIN_UNCONFIGURED", "Configure a 4–8 digit server DEMO_PIN.", 503);
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) bad();
  store.checkPin(timingSafeEqual(hash(pin), hash(process.env.DEMO_PIN)));
}
const fields = {
  settlements: ["symbol", "outcome", "resolutionSide", "positionQuantity", "netProfit", "payout", "settledAt"],
  orders: [
    "orderId",
    "symbol",
    "side",
    "outcome",
    "status",
    "quantity",
    "price",
    "filledQuantity",
    "remainingQuantity",
    "avgExecutionPrice",
  ],
  positions: ["symbol", "outcome", "totalQuantity", "quantityOnHold", "avgPrice", "marketValue", "unrealizedPnl", "netProfit", "markPrice"],
};
async function accountSection(path, kind) {
  const settled = kind === "settlements";
  const r = settled ? await gPrivate(path, {}, { query: { limit: 5 } }) : await gPrivate(path);
  const rows = r.data?.[settled ? "positions" : kind];
  if (!r.ok || !Array.isArray(rows)) return { error: "Gemini Sandbox data unavailable.", rows: [] };
  return {
    rows: rows
      .slice(0, settled ? 5 : 100)
      .map((row) => {
        const result = Object.fromEntries(fields[kind]
          .filter((key) => ["string", "number"].includes(typeof row?.[key]))
          .map((key) => [key, row[key]]));
        if (kind === "positions" && ["yes", "no"].includes(String(row?.outcome).toLowerCase())) {
          const bid = row.prices?.sell?.[row.outcome.toLowerCase()];
          if (["string", "number"].includes(typeof bid)) result.current_bid = bid;
        }
        if (typeof row?.contractMetadata?.eventName === "string") result.event_title = row.contractMetadata.eventName;
        if (typeof row?.contractMetadata?.contractName === "string") result.contract_label = row.contractMetadata.contractName;
        return result;
      }),
  };
}
export function browserTrading(repo, { settlementCallback } = {}) {
  const store = new TradingRepository(repo);
  const devices = new TrustedDevices(repo);
  return async ({ path, method, token, body, key, host, deviceCookie, setDeviceCookie }) => {
    const device = devices.identify(host, deviceCookie);
    const config = availability(Boolean(device));
    if (method === "GET" && path === "availability") return config;
    if (path === "settlement-callback" && settlementCallback && ["GET", "POST"].includes(method)) {
      if (!device) throw new TradeError("DEVICE_REQUIRED", "Pair this browser to manage settlement calls.", 403);
      return settlementCallback(repo, method, body);
    }
    if (method !== "POST") bad();
    if (path === "pair") {
      if (keysAre(body, ["pin"])) requirePin(store, body.pin);
      else if (keysAre(body, ["pairing_token"])) devices.redeem(body.pairing_token);
      else bad();
      setDeviceCookie(devices.grant(host), deviceLifetimeSeconds);
      return availability(true);
    }
    if (path === "portfolio") {
      if (keysAre(body, ["pin"])) requirePin(store, body.pin);
      else if (!keysAre(body, []) || !device) throw new TradeError("DEVICE_REQUIRED", "Unlock this device to view your account.", 403);
      if (!hasCredentials())
        throw new TradeError(
          "ACCOUNT_UNCONFIGURED",
          "Configure Gemini sandbox account credentials.",
          503,
        );
      const [orders, positions, history, settlements] = await Promise.all([
        accountSection("/v1/prediction-markets/orders/active", "orders"),
        accountSection("/v1/prediction-markets/positions", "positions"),
        accountSection("/v1/prediction-markets/orders/history", "orders"),
        accountSection("/v1/prediction-markets/positions/settled", "settlements"),
      ]);
      return { ok: true, as_of: new Date().toISOString(), orders, positions, history, settlements };
    }
    const owner = sessionOwner(repo, token);
    if (path === "proposals") {
      const keys = ["event_ticker", "contract_symbol", "outcome", body && Object.hasOwn(body, "budget_usd") ? "budget_usd" : "quantity", "limit_price"];
      if (
        !keysAre(body, keys) ||
        !uuid.test(key) ||
        !keys.slice(0, 2).every((k) => typeof body[k] === "string" && symbol.test(body[k])) ||
        !["yes", "no"].includes(body.outcome) ||
        !isValidBuySize(body) ||
        !Number.isFinite(body.limit_price) ||
        body.limit_price < 0.01 ||
        body.limit_price > 0.99 ||
        Math.abs(Math.round(body.limit_price * 100) - body.limit_price * 100) > 1e-8
      )
        bad();
      // Preserve existing quantity fingerprints and distinguish equal numeric dollar amounts.
      const fingerprint = JSON.stringify(keys.map((k) => k === "budget_usd" ? { budget_usd: body[k] } : body[k]));
      const replay = store.replay(owner, key, fingerprint);
      const present = (proposal) => ({ ok: true, proposal, availability: config });
      if (replay) return present(replay);
      const response = await prepareTrade(
        { ...body, instrument_symbol: body.contract_symbol, side: "buy" },
        (terms) => {
          sessionOwner(repo, token);
          if (device && terms.title && terms.contract_label &&
              ![terms.title, terms.contract_label].some(name => name === terms.instrument_symbol || name === terms.event_ticker || /GEMI-[A-Z0-9._-]+/i.test(name))) {
            terms.voice_readback = `Buy ${terms.quantity} ${terms.outcome.toUpperCase()} on ${terms.title}, ${terms.contract_label}, at up to ${Math.round(100 * terms.limit_price)} cents each. About $${(terms.notional_usd + terms.est_fee_usd).toFixed(2)} at risk including estimated fees, $${terms.quantity} payout if all fill and win. Say confirm.`;
          }
          const proposal = store.propose(owner, key, fingerprint, terms, LIMITS.maxDailyUsd,
            terms.voice_readback ? id => devices.bind(id, owner, device) : undefined);
          return Response.json(present(proposal));
        },
      );
      const { detail, ...safe } = await response.json();
      return safe;
    }
    const voice = path === "voice-confirm";
    if ((!voice && path !== "approve") || !keysAre(body, ["proposal_id", voice ? "confirmation_seq" : "pin"]) ||
        !uuid.test(body.proposal_id)) bad();
    if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
    if (voice) {
      if (!device) throw new TradeError("DEVICE_REQUIRED", "Pair this browser to approve by voice.", 403);
      if (!Number.isSafeInteger(body.confirmation_seq) || body.confirmation_seq <= 0) bad();

    } else requirePin(store, body.pin);
    const claim = store.claim(owner, body.proposal_id, LIMITS, voice
      ? () => devices.confirm(body.proposal_id, owner, device, body.confirmation_seq) : undefined);
    if (claim.result) return claim.result;
    const id = body.proposal_id;
    const audit = (kind, detail) => store.audit(id, kind, detail);
    const response = await executeTrade(claim.terms, owner, {
      finish: (status) => audit("state", status),
      log: (kind) => audit("activity", kind),
      receipt: (_id, _code, kind, data) => audit(kind, data),
      saveOrder: (order) =>
        audit("exchange", { order_id: order.gemini_order_id, outcome: order.outcome_summary }),
    });
    const { exchange_error, detail, ...result } = await response.json();
    store.finish(id, result);
    return result;
  };
}

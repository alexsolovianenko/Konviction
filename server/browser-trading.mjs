import { createHash, timingSafeEqual } from "node:crypto";
import { prepareTrade, executeTrade, isValidBuySize } from "../src/server/v2p/trade-engine.ts";
import { gPrivate, hasCredentials } from "../src/server/v2p/gemini.ts";
import { LIMITS } from "../src/server/v2p/util.ts";
import { TradingRepository, TradeError } from "./trading-repository.mjs";

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
export function availability() {
  const missing = [];
  if (!hasCredentials()) missing.push("Gemini sandbox account credentials");
  if (!/^\d{4,8}$/.test(process.env.DEMO_PIN ?? "")) missing.push("a 4–8 digit server DEMO_PIN");
  if (process.env.EXECUTION_ENABLED !== "true") missing.push("EXECUTION_ENABLED=true");
  return {
    ok: true,
    execution_enabled: !missing.length,
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
  positions: ["symbol", "outcome", "totalQuantity", "quantityOnHold", "avgPrice", "marketValue"],
};
async function accountSection(path, kind) {
  const r = await gPrivate(path);
  const rows = r.data?.[kind];
  if (!r.ok || !Array.isArray(rows)) return { error: "Gemini Sandbox data unavailable.", rows: [] };
  return {
    rows: rows
      .slice(0, 100)
      .map((row) =>
        Object.fromEntries(
          fields[kind]
            .filter((key) => ["string", "number"].includes(typeof row?.[key]))
            .map((key) => [key, row[key]]),
        ),
      ),
  };
}
export function browserTrading(repo) {
  const store = new TradingRepository(repo);
  return async ({ path, method, token, body, key }) => {
    if (method === "GET" && path === "availability") return availability();
    if (method !== "POST") bad();
    if (path === "portfolio") {
      if (!keysAre(body, ["pin"])) bad();
      requirePin(store, body.pin);
      if (!hasCredentials())
        throw new TradeError(
          "ACCOUNT_UNCONFIGURED",
          "Configure Gemini sandbox account credentials.",
          503,
        );
      const [orders, positions, history] = await Promise.all([
        accountSection("/v1/prediction-markets/orders/active", "orders"),
        accountSection("/v1/prediction-markets/positions", "positions"),
        accountSection("/v1/prediction-markets/orders/history", "orders"),
      ]);
      return { ok: true, as_of: new Date().toISOString(), orders, positions, history };
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
      const present = (proposal) => ({ ok: true, proposal, ...{ availability: availability() } });
      if (replay) return present(replay);
      const response = await prepareTrade(
        { ...body, instrument_symbol: body.contract_symbol, side: "buy" },
        (terms) => {
          sessionOwner(repo, token);
          return Response.json(
            present(store.propose(owner, key, fingerprint, terms, LIMITS.maxDailyUsd)),
          );
        },
      );
      const { detail, ...safe } = await response.json();
      return safe;
    }
    if (
      path !== "approve" ||
      !keysAre(body, ["proposal_id", "pin"]) ||
      !uuid.test(body.proposal_id)
    )
      bad();
    const config = availability();
    if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
    requirePin(store, body.pin);
    const claim = store.claim(owner, body.proposal_id, LIMITS);
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

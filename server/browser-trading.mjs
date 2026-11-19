import { buildSandboxCombo } from "../src/server/v2p/build-combo.ts";
import { spokenBudgetFill, spokenFill } from "../src/spoken-fill.ts";
import { validOrderKeys } from "../src/server/v2p/browser-order-input.ts";
import { sandboxPortfolio } from "../src/server/v2p/portfolio.ts";
import { hasSpokenMarketName, spokenProposal } from "./spoken-proposal.mjs";
import { createHash } from "node:crypto";
import { prepareTrade, executeTrade } from "../src/server/v2p/trade-engine.ts";
import { hasCredentials } from "../src/server/v2p/gemini.ts";
import { settledOpenOrders } from "../src/server/v2p/reconcile-open.ts";
import { feeEstimate } from "../src/server/v2p/util.ts";
import { TradingRepository, TradeError } from "./trading-repository.mjs";

import { TrustedDevices, deviceLifetimeSeconds } from "./trusted-device.mjs";

const keysAre = (obj, keys) =>
  obj &&
  typeof obj === "object" &&
  Object.keys(obj).length === keys.length &&
  keys.every((k) => Object.hasOwn(obj, k));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (text) => createHash("sha256").update(text).digest();
const bad = () => {
  throw new TradeError("BAD_INPUT", "Invalid trade parameters.", 400);
};
export function availability(voiceAuthorized = false) {
  const missing = [];
  if (!hasCredentials()) missing.push("Gemini sandbox account credentials");
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
export function browserTrading(repo) {
  const store = new TradingRepository(repo);
  const devices = new TrustedDevices(repo);
  async function reconcile(history) {
    const open = store.openOrders();
    if (!open.length) return;
    const terminal = await settledOpenOrders(open, history);
    for (const record of terminal) {
      const original = open.find(order => order.intent_id === record.intent_id);
      const fee = feeEstimate(record.filled_qty, record.avg_price ?? original.limit_price);
      const say = record.filled_qty > 0
        ? `Filled ${record.filled_qty} of ${original.quantity} sandbox contracts.`
        : "The sandbox order closed without a fill.";
      store.finalizeOpenOrder(record.intent_id, {
        ok: true, order_id: original.gemini_order_id, outcome_summary: record.outcome_summary,
        exchange_status: record.exchange_status, filled_quantity: record.filled_qty,
        remaining_quantity: record.remaining_qty, avg_price: record.avg_price, est_fee_usd: fee, say,
        voice_say: spokenBudgetFill(original, record.outcome_summary, record.filled_qty, record.avg_price) ?? spokenFill(record.outcome_summary, record.filled_qty, original.quantity, record.avg_price) ?? say,
      }, original.side === "sell" ? 0 : Math.round((record.filled_notional_usd + fee) * 100));
    }
  }
  return async ({ path, method, token, body, key, host, deviceCookie, setDeviceCookie }) => {
    const device = devices.identify(host, deviceCookie);
    const config = availability(Boolean(device));
    if (method === "GET" && path === "availability") return config;
    if (method !== "POST") bad();
    if (path === "pair") {
      if (keysAre(body, ["pairing_token"])) devices.redeem(body.pairing_token);
      else bad();
      setDeviceCookie(devices.grant(host), deviceLifetimeSeconds);
      return availability(true);
    }
    if (path === "portfolio") {
      if (!keysAre(body, [])) bad();
      if (!hasCredentials())
        throw new TradeError(
          "ACCOUNT_UNCONFIGURED",
          "Configure Gemini sandbox account credentials.",
          503,
        );
      const account = await sandboxPortfolio();
      if (!account.history.error) await reconcile(account.history.rows);
      return account;
    }
    const owner = sessionOwner(repo, token);
    if (path === "build-combo") {
      if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
      return buildSandboxCombo(body);
    }
    if (path === "proposals") {
      const keys = validOrderKeys(body);
      if (!keys || !uuid.test(key)) bad();
      // Preserve existing quantity fingerprints and distinguish equal numeric dollar amounts.
      const fingerprint = JSON.stringify(keys.map((k) => ["budget_usd", "close_all", "side", "order_mode"].includes(k) ? { [k]: body[k] } : body[k]));
      const replay = store.replay(owner, key, fingerprint);
      const present = (proposal) => ({ ok: true, proposal, availability: { ...config, voice_authorized: true } });
      if (replay) return present(replay);
      const response = await prepareTrade(
        { ...body, instrument_symbol: body.contract_symbol, side: body.side ?? "buy" },
        async (terms) => {
          if (!hasSpokenMarketName(terms))
            throw new TradeError("BAD_INPUT", "A human-readable contract name is required for spoken confirmation.", 409);
          terms.voice_readback = spokenProposal(terms);
          sessionOwner(repo, token);
          const proposal = store.propose(owner, key, fingerprint, terms,
            id => devices.bind(id, owner));
          return Response.json(present(proposal));
        },
      );
      const { detail, ...safe } = await response.json();
      return safe;
    }
    if (path === "dismiss-proposal") {
      if (!keysAre(body, ["proposal_id"]) || !uuid.test(body.proposal_id)) bad();
      store.dismiss(owner, body.proposal_id);
      return { ok: true };
    }
    if (path !== "voice-confirm") throw new TradeError("NOT_FOUND", "Unknown trading action.", 404);
    if (!keysAre(body, ["proposal_id", "confirmation_seq"]) || !uuid.test(body.proposal_id) ||
        !Number.isSafeInteger(body.confirmation_seq) || body.confirmation_seq <= 0) bad();
    if (!config.execution_enabled) throw new TradeError("EXECUTION_DISABLED", config.message, 503);
    const claim = store.claim(owner, body.proposal_id,
      () => devices.confirm(body.proposal_id, owner, body.confirmation_seq));
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

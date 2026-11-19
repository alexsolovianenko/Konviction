// @ts-nocheck -- shared with the mechanically ported phone backend.
import { contractTradable, gPublic, findContract, getEvent, gPrivate, quoteFor } from "./gemini";
import { spokenBudgetFill, spokenFill } from "../../spoken-fill";
import { liquiditySnapshot } from "./book-liquidity";
import { comboEligibility } from "./native-combo";
import { BUY_CUTOFF_MS, cents, feeEstimate, hashPhone, json, LIMITS, num, round2 } from "./util";
type Body = Record<string, any>;
const err = (error: string, message: string, extra = {}) =>
  json({ ok: false, error, message, ...extra });

// A browser buy is sized by either a count or an all-in USD ceiling.
export function isValidBuySize(body: Body): boolean {
  if (!body || typeof body !== "object") return false;
  if (Object.hasOwn(body, "budget_usd")) {
    const dollars = body.budget_usd;
    if (Object.hasOwn(body, "quantity") || typeof dollars !== "number" || dollars <= 0) return false;
    const cents = Math.round(dollars * 100);
    return Number.isSafeInteger(cents) && cents / 100 === dollars;
  }
  return Number.isSafeInteger(body.quantity) && body.quantity > 0;
}

function budgetQuantity(budget: number, limit: number): number {
  const availableCents = Math.round(budget * 100);
  if (!Number.isSafeInteger(availableCents) || availableCents <= 0) return 0;
  const priceCents = Math.round(limit * 100);
  let high = Math.floor(availableCents / priceCents);
  let low = 0;
  while (low < high) {
    const qty = low + Math.ceil((high - low) / 2);
    const totalCents = qty * priceCents + Math.round(feeEstimate(qty, limit) * 100);
    if (totalCents <= availableCents) low = qty;
    else high = qty - 1;
  }
  return low;
}

export async function prepareTrade(b: Body, saveProposal) {
  const side = String(b.side ?? "").toLowerCase();
  const outcome = String(b.outcome ?? "").toLowerCase();
  const symbol = String(b.instrument_symbol ?? "");
  const eventTicker = String(b.event_ticker ?? "");
  if (!["buy", "sell"].includes(side)) return err("BAD_INPUT", "side must be buy or sell");
  if (!["yes", "no"].includes(outcome)) return err("BAD_INPUT", "outcome must be yes or no");
  if (!symbol || !eventTicker)
    return err(
      "BAD_INPUT",
      "Call find_market (or get_portfolio for a sell) first and pass instrument_symbol and event_ticker exactly.",
    );

  const market = b.order_mode === "market";
  if (b.order_mode !== undefined && !["market", "limit"].includes(b.order_mode))
    return err("BAD_INPUT", "Unsupported order mode.");
  const budget = num(b.budget_usd);
  const qtyIn = num(b.quantity);
  const priceLimitIn = num(b.max_price ?? b.limit_price);

  const { event, error } = await getEvent(eventTicker);
  if (error || !event)
    return err(
      "MARKET_DATA_UNAVAILABLE",
      "Gemini’s quote is unavailable. Request a fresh quote before preparing an order.",
      { detail: error },
    );
  const c = findContract(event, symbol);
  if (!c || event.ticker !== eventTicker)
    return err("BAD_INPUT", "That contract isn't in this event. Call find_market again.");
  if (!contractTradable(c) || !c.status || !c.marketState)
    return err("CONTRACT_NOT_OPEN", "This contract is unavailable for immediate trading. Look for an open contract.");
  const comboError = await comboEligibility(event, c);
  if (comboError) return err("COMBO_UNAVAILABLE", comboError);
  const expiryIso = c.expiryDate ?? event.expiryDate ?? null;
  if (expiryIso && Date.parse(expiryIso) <= Date.now())
    return err("CONTRACT_NOT_OPEN", "This contract has expired.");
  if (expiryIso && Date.parse(expiryIso) - Date.now() <= BUY_CUTOFF_MS)
    return err("TOO_CLOSE_TO_EXPIRY", "Ten seconds or less remain in this market.");
  const q = quoteFor(c, outcome as "yes" | "no");
  const label = c.label ?? c.ticker ?? symbol;
  const outcomeText = outcome === "yes" ? `YES (${label})` : `NO (not ${label})`;

  let quantity: number, limit: number, quotePrice: number | null;
  if (side === "buy") {
    if (q.buy === null && (market || priceLimitIn === null || c.isCombo))
      return err(
        "NO_LIQUIDITY",
        c.isCombo ? "No ask for this combo." : "No ask available. What limit price?",
      );
    quotePrice = q.buy;
    limit = market ? Math.min(priceLimitIn ?? q.buy, q.buy) : priceLimitIn ?? q.buy;
    if (market && q.buy > limit)
      return err("PRICE_ABOVE_YOUR_MAX", "The ask is above your price ceiling.");
    if (limit < LIMITS.minLimitPrice || limit > LIMITS.maxLimitPrice)
      return err("INVALID_PRICE", `The order limit must be between 1¢ and ${cents(LIMITS.maxLimitPrice)}.`, { max_price: LIMITS.maxLimitPrice });
    if (Math.abs(limit * 100 - Math.round(limit * 100)) > 1e-8)
      return err("BAD_INPUT", "The quoted price cannot be submitted in whole cents.");
    if (qtyIn !== null) {
      quantity = Math.floor(qtyIn);
    } else if (budget !== null) {
      quantity = budgetQuantity(budget, market ? q.buy : limit);
    } else {
      return err(
        "BAD_INPUT",
        "Ask whether the caller means a dollar amount or a number of contracts.",
      );
    }
  } else {
    if (budget !== null || (b.close_all === true) === (qtyIn !== null))
      return err("BAD_INPUT", "Choose a quantity to sell or close the whole available position.");
    const pos = await gPrivate("/v1/prediction-markets/positions");
    if (!pos.ok || !Array.isArray(pos.data?.positions))
      return err("EXCHANGE_ERROR", "Gemini could not verify your position.");
    const held = pos.data.positions.find(p => p.symbol === symbol && String(p.outcome).toLowerCase() === outcome);
    if (!held) return err("INSUFFICIENT_POSITION", "No open position for that contract and outcome.");
    const total = num(held.totalQuantity);
    const onHold = num(held.quantityOnHold);
    if (total === null || onHold === null || total < 0 || onHold < 0 || onHold > total)
      return err("EXCHANGE_ERROR", "Available position size is unconfirmed.");
    const available = Number((total - onHold).toPrecision(15));
    if (available <= 0) return err("INSUFFICIENT_POSITION", "No contracts are available to sell.");
    quantity = b.close_all === true ? available : qtyIn;
    if (!(quantity > 0)) return err("BAD_INPUT", "Sell quantity must be positive.");
    if (quantity > available)
      return err("INSUFFICIENT_POSITION", `Only ${available} contracts are available to sell.`, { available });
    const increment = num(c.quantityIncrement);
    if (increment !== null && increment > 0 && Math.abs(quantity / increment - Math.round(quantity / increment)) > 1e-8)
      return err("INVALID_QUANTITY", `Gemini requires quantities in increments of ${increment} for this contract.`, { available, increment });
    quotePrice = q.sell;
    if (quotePrice === null && (market || priceLimitIn === null))
      return err("NO_BID", "No bid right now.");
    limit = priceLimitIn ?? (market ? LIMITS.minLimitPrice : quotePrice);
    if (!(limit >= LIMITS.minLimitPrice && limit <= 0.99))
      return err("INVALID_PRICE", "Choose a sell limit from 1 to 99 cents.");
    if (market && quotePrice < limit)
      return err("PRICE_BELOW_YOUR_MIN", "The current bid is below your minimum.", { current_bid: quotePrice });
  }

  if (side === "buy" && (!Number.isFinite(quantity) || quantity < 1))
    return err("BUDGET_TOO_SMALL", "That amount is too small to buy even one contract at this price.");
  const minimum = num(c.quantityMinimum);
  if (minimum !== null && quantity < minimum)
    return err("BELOW_CONTRACT_MINIMUM", `Gemini requires at least ${minimum} contracts for this market. Your order sizes to ${quantity}. Choose another contract or request a new size.`);
  const estimatePrice = side === "sell" && market ? q.sell : limit;
  const notional = round2(quantity * estimatePrice);
  const fee = feeEstimate(quantity, estimatePrice);
  const confirmationEnd = Date.now() + LIMITS.intentTtlSeconds * 1000;
  const marketCutoff = expiryIso ? Date.parse(expiryIso) - BUY_CUTOFF_MS : Infinity;
  const expiresAt = new Date(Math.min(confirmationEnd, Number.isFinite(marketCutoff) ? marketCutoff : Infinity)).toISOString();
  const readback =
    side === "buy"
      ? `Buy ${quantity} ${outcomeText} on "${event.title}" at up to ${cents(limit)}. Confirm?`
      : `Sell ${quantity} ${outcomeText} ${market ? "at market" : "at " + cents(limit) + " or more"}. Confirm?`;

  return saveProposal({
    side,
    ...(side === "buy" && budget !== null && {budget_usd: budget}),
    ...(market && {order_mode: "market"}),
    time_in_force: market ? "immediate-or-cancel" : "good-til-cancel",
    event_ticker: eventTicker,
    instrument_symbol: symbol,
    title: event.title,
    contract_label: label,
    outcome,
    quantity,
    limit_price: limit,
    notional_usd: notional,
    est_fee_usd: fee,
    quote_price: quotePrice,
    quote_at: new Date().toISOString(),
    contract_expiry: expiryIso,
    expires_at: expiresAt,
    readback,
  });
}

function rejectionMessage(data: Record<string, unknown> | null, status: number): string {
  const reasons: Record<string, string> = {
    InsufficientFunds: "Your available sandbox balance is too low. Check your balance and prepare a smaller order.",
    InsufficientLiquidity: "Gemini reported insufficient liquidity at this price. Request a fresh quote before trying a smaller order.",
    MarketNotOpen: "This contract is closed or paused. Select an open contract.",
    InvalidQuantity: "Gemini rejected the contract quantity. Check the contract’s minimum and quantity increment.",
    InvalidPrice: "Gemini rejected the limit price. Prepare a new order using a fresh quote.",
    LimitPriceOffTick: "The limit price missed the contract’s price increment. Prepare a fresh quote.",
    TERMS_NOT_ACCEPTED: "Accept the prediction market terms in your Gemini sandbox account before trying again.",
    InvalidNonce: "Gemini rejected the request sequence. Refresh the account before preparing a new order.",
    DuplicateOrder: "Gemini flagged a duplicate order. Check order history before placing another order.",
  };
  const reason = data?.reason ?? data?.error;
  if (typeof reason === "string" && Object.hasOwn(reasons, reason)) return reasons[reason];
  if (status === 429) return "Gemini rate-limited the order. Wait before requesting a fresh quote.";
  if (status === 401 || status === 403) return "Gemini denied the order. Check the sandbox API key’s trading permissions.";
  return "Gemini rejected the order without a recognized reason. Check the sandbox account’s permissions and contract status before retrying.";
}

export function classifyExchangeOrder(order, quantity: number, resting = true) {
  const status = String(order?.status ?? "").toLowerCase();
  const filled = exchangeQuantity(order?.filledQuantity);
  if (filled === null || filled < 0 || filled > quantity) return "PENDING_UNKNOWN";
  if (filled === quantity) return "FILLED";
  if (resting && order?.orderId && status === "open") return "OPEN";
  if (["cancelled", "canceled", "closed"].includes(status)) return filled === 0 ? "NOT_FILLED" : "PARTIAL";
  return "PENDING_UNKNOWN";
}

function exchangeQuantity(value: unknown) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d*\.?\d+$/.test(value))) return null;
  return num(value);
}

export function remainderBuy(intent, summary, filled, status) {
  if (intent.order_mode === "market" || intent.side !== "buy" || !["PARTIAL", "NOT_FILLED"].includes(summary) ||
      !["cancelled", "canceled", "closed"].includes(String(status).toLowerCase())) return null;
  const executed = exchangeQuantity(filled);
  const quantity = Number(intent.quantity) - executed;
  if (!Number.isSafeInteger(executed) || executed < 0 || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
  return { event_ticker: intent.event_ticker, contract_symbol: intent.instrument_symbol, outcome: intent.outcome,
    quantity, limit_price: Number(intent.limit_price) };
}

export async function executeTrade(it, caller, { finish, log, receipt, saveOrder }) {
  const code = it.code;
  // Re-quote at execution time.
  const { event, error: qErr } = await getEvent(it.event_ticker);
  const c = findContract(event, it.instrument_symbol);
  if (qErr || !c || event?.ticker !== it.event_ticker) {
    await finish("FAILED");
    return err("MARKET_DATA_UNAVAILABLE", "Couldn't re-check the price. Nothing was placed.");
  }
  if (!contractTradable(c) || !c.status || !c.marketState) {
    await finish("REJECTED");
    return err("CONTRACT_NOT_OPEN", "This contract is unavailable for immediate trading. Choose an open contract for a new proposal.");
  }
  const comboError = await comboEligibility(event, c);
  if (comboError) {
    await finish("REJECTED");
    return err("COMBO_UNAVAILABLE", comboError);
  }
  const q = quoteFor(c, it.outcome);
  const limit = Number(it.limit_price);
  // The signed limit caps the exchange price even if the ask changes between
  // this snapshot and matching. A buy below the current ask can still be tried.
  if (it.side === "sell" && it.time_in_force !== "good-til-cancel" && it.order_mode !== "market" && (q.sell === null || q.sell < limit - 1e-9)) {
    await finish("REJECTED");
    await log("PRICE_MOVED", caller, `${code}: bid now ${q.sell ?? "none"} vs min ${limit}`);
    return err(
      "PRICE_MOVED",
      `The bid moved${q.sell !== null ? ` to ${cents(q.sell)}` : " (no buyers now)"}. Nothing was sold. Offer to prepare a new sell.`,
      { current_bid: q.sell },
    );
  }

  const expiry = c.expiryDate ?? event.expiryDate;
  if (expiry && Date.parse(expiry) <= Date.now()) {
    await finish("REJECTED");
    return err("CONTRACT_NOT_OPEN", "This contract has expired.");
  }
  const submitBefore = expiry && (it.side === "buy" || it.order_mode === "market" || it.time_in_force === "good-til-cancel") ? Date.parse(expiry) - BUY_CUTOFF_MS : undefined;
  if (submitBefore !== undefined && Date.now() >= submitBefore) {
    await finish("REJECTED");
    return err("TOO_CLOSE_TO_EXPIRY", "Ten seconds or less remain in this market.");
  }
  if (it.side === "sell") {
    const positions = await gPrivate("/v1/prediction-markets/positions");
    const holding = positions.data?.positions?.find(p => p.symbol === it.instrument_symbol && String(p.outcome).toLowerCase() === it.outcome);
    const held = num(holding?.totalQuantity), onHold = num(holding?.quantityOnHold);
    if (!positions.ok || held === null || onHold === null || Number(it.quantity) > held - onHold + 1e-9) {
      await finish("REJECTED");
      return err("INSUFFICIENT_POSITION", "The confirmed quantity is no longer available to sell.");
    }
  }
  if (it.order_mode === "market") return executeMarketOrder(it, caller, c, submitBefore, {finish, log, receipt, saveOrder});
  const callerHash = await hashPhone(caller);

  // Older proposals promised immediate cancellation and must retain that condition.
  const resting = it.time_in_force === "good-til-cancel";
  const orderFields = {
    symbol: it.instrument_symbol,
    orderType: "limit",
    side: it.side,
    outcome: it.outcome,
    quantity: String(it.quantity),
    price: limit.toFixed(2),
    timeInForce: resting ? "good-til-cancel" : "immediate-or-cancel",
    makerOrCancel: false,
  };
  await Promise.all([
    receipt(it.id, code, "approval", {
      caller_hash: callerHash,
      side: it.side,
      instrument_symbol: it.instrument_symbol,
      outcome: it.outcome,
      quantity: it.quantity,
      limit_price: limit,
      approved_at: new Date().toISOString(),
      quote_at_execution: it.side === "buy" ? q.buy : q.sell,
    }),
    log("ORDER_SENT", caller, `${code}: sending ${orderFields.timeInForce} ${it.side} ${it.quantity} ${it.outcome} @ ${limit.toFixed(2)}`, orderFields),
  ]);
  const placed = await gPrivate("/v1/prediction-markets/order", orderFields, { submitBefore });
  if (placed.missedDeadline) {
    await finish("REJECTED");
    return err("TOO_CLOSE_TO_EXPIRY", "Ten seconds or less remained before submission.");
  }

  let summary: "OPEN" | "FILLED" | "PARTIAL" | "NOT_FILLED" | "PENDING_UNKNOWN" | "EXCHANGE_REJECTED";
  // deno-lint-ignore no-explicit-any
  let o: any = placed.data;
  if (placed.status === 0 || placed.status === 408 || placed.status >= 500) {
    summary = "PENDING_UNKNOWN";
  } else if (!placed.ok) {
    summary = "EXCHANGE_REJECTED";
  } else {
    summary = classifyExchangeOrder(o, Number(it.quantity), resting);
    if (o?.orderId && summary === "PENDING_UNKNOWN") {
      const h = await gPrivate("/v1/prediction-markets/orders/history", {
        symbol: it.instrument_symbol,
        limit: 20,
      });
      const match = (h.data?.orders ?? []).find(
        (x: any) => String(x.orderId) === String(o.orderId),
      );
      if (h.ok && match) {
        o = match;
        summary = classifyExchangeOrder(o, Number(it.quantity), resting);
      }
    }
  }

  const filledQty = exchangeQuantity(o?.filledQuantity);
  const avg = num(o?.avgExecutionPrice);
  const filledNotional =
    filledQty && avg ? round2(filledQty * avg) : filledQty ? round2(filledQty * limit) : 0;
  await saveOrder({
    intent_id: it.id,
    side: it.side,
    gemini_order_id: o?.orderId !== undefined && o?.orderId !== null ? String(o.orderId) : null,
    outcome_summary: summary,
    exchange_status: o?.status ?? null,
    filled_qty: filledQty,
    remaining_qty: num(o?.remainingQuantity),
    avg_price: avg,
    filled_notional_usd: it.side === "buy" ? filledNotional : 0,
    error: placed.ok ? null : (placed.error ?? placed.text.slice(0, 500)),
    raw: placed.data ?? { error: placed.error },
  });
  await finish(summary === "EXCHANGE_REJECTED" ? "FAILED" : "DONE");
  await log(
    `ORDER_${summary}`,
    caller,
    `${code}: ${summary} — filled ${filledQty ?? 0}/${it.quantity}${avg !== null ? ` avg ${avg}` : ""}${o?.orderId ? ` (order ${o.orderId})` : ""}`,
    {
      order_id: o?.orderId ? String(o.orderId) : null,
      http_status: placed.status,
      response: placed.data ?? placed.error,
    },
  );

  await receipt(it.id, code, "result", {
    caller_hash: callerHash,
    gemini_order_id: o?.orderId ? String(o.orderId) : null,
    outcome_summary: summary,
    exchange_status: o?.status ?? null,
    filled_quantity: filledQty,
    avg_execution_price: avg,
    recorded_at: new Date().toISOString(),
  });

  const fillFee = filledQty && avg ? feeEstimate(filledQty, avg) : null;
  // IOC orders may finish as cancelled even after a complete fill. Report the
  // exchange quantity first. A quote does not establish available depth.
  const cancelled = ["cancelled", "canceled"].includes(String(o?.status ?? "").toLowerCase());
  const rejection = rejectionMessage(placed.data, placed.status);
  const voiceReasons: Record<string, string> = {
    InsufficientFunds: "Insufficient sandbox balance.",
    InsufficientLiquidity: "Insufficient liquidity at that price.",
    MarketNotOpen: "Market closed or paused.",
    InvalidQuantity: "Check the contract quantity.",
    DuplicateOrder: "Check your existing order.",
  };
  const reason = placed.data?.reason ?? placed.data?.error;
  const average = avg !== null ? ` at an average of ${cents(avg)}` : "";
  const say: Record<string, string> = {
    OPEN: filledQty > 0
      ? `${filledQty} filled. The rest is open at ${cents(limit)}.`
      : `Sandbox limit order open at ${cents(limit)}.`,
    FILLED: `Filled ${filledQty} of ${it.quantity} sandbox contracts${average}.`,
    PARTIAL: `Filled ${filledQty} of ${it.quantity} sandbox contracts${average}.`,
    NOT_FILLED: `Zero of ${it.quantity} contracts filled at your ${cents(limit)} limit.`,
    PENDING_UNKNOWN: filledQty !== null && filledQty > 0 && filledQty <= it.quantity
      ? `Gemini reports ${filledQty} filled so far. Check order history for the final quantity before placing another order.`
      : "Gemini has not confirmed the final fill. Check order history before placing another order.",
    EXCHANGE_REJECTED: rejection,
  };
  const remainder = remainderBuy(it, summary, filledQty, o?.status);
  if (summary === "PARTIAL" || summary === "NOT_FILLED") {
    if (cancelled) say[summary] += " Gemini cancelled the unfilled contracts.";
    if (it.side === "buy") {
      let depth = "Resting quantity at your limit was unknown.";
      if (o?.reason === "InsufficientLiquidity") {
        depth = "Gemini reported insufficient resting liquidity at your limit.";
      } else if (q.buy !== null && q.buy > limit) {
        depth = "The best ask before submission was above your limit.";
      } else {
        // This later snapshot describes the current book, never the cause of a past fill.
        const book = await gPublic("/v1/book/" + encodeURIComponent(it.instrument_symbol), {limit_bids: 0, limit_asks: 0});
        const unfilled = it.quantity - filledQty;
        const { displayed_quantity: size } = liquiditySnapshot(book?.ok ? book.data : null,
          { outcome: it.outcome, side: "buy", quantity: unfilled, limit_price: limit });
        if (size !== null && size < unfilled)
          depth = `The book now shows only ${size} contracts at or below your limit, too few for the remainder.`;
        else if (size !== null)
          depth = `The book now shows ${size} contracts at or below your limit. Available size can change.`;
      }
      say[summary] += " " + depth;
    }
    if (remainder) say[summary] += ` Ask to retry the remaining ${remainder.quantity} at up to ${cents(limit)} each.`;
  }
  return json({
    ok: summary !== "EXCHANGE_REJECTED",
    outcome_summary: summary,
    order_id: o?.orderId ? String(o.orderId) : null,
    exchange_status: o?.status ?? null,
    filled_quantity: filledQty,
    remaining_quantity: num(o?.remainingQuantity),
    avg_price: avg,
    est_fee_usd: fillFee,
    ...(remainder && { remainder_buy: remainder }),
    say: say[summary],
    voice_say: spokenBudgetFill(it, summary, filledQty, avg) ?? spokenFill(summary, filledQty, it.quantity, avg) ?? say[summary],
    ...(summary === "EXCHANGE_REJECTED" && { voice_say: typeof reason === "string" && Object.hasOwn(voiceReasons, reason) ? voiceReasons[reason] : "Rejected. Check order details." }),
  });
}

// A buy submits one IOC at the quoted ceiling. Market exits retain their confirmed retry policy.
async function executeMarketOrder(it, caller, contract, submitBefore, { finish, log, receipt, saveOrder }) {
  const target = Number(it.quantity);
  const buy = it.side === "buy";
  const limit = buy ? Math.min(Number(it.limit_price), Number(it.quote_price ?? it.limit_price)) : Number(it.limit_price);
  const maxCost = round2(Number(it.notional_usd) + Number(it.est_fee_usd));
  let spent = 0, fees = 0, filled = 0;
  let knownAverage = true, uncertain = false, rejected = false;
  let reason = "";
  const attempts = [];
  await receipt(it.id, it.code, "approval", {
    caller_hash: await hashPhone(caller), instrument_symbol: it.instrument_symbol, outcome: it.outcome,
    side: it.side, quantity: target, order_mode: "market", ...(buy && {max_cost_usd: maxCost}), limit_price: limit,
    approved_at: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < (buy ? 1 : 2); attempt++) {
    if (attempt) {
      const { event } = await getEvent(it.event_ticker);
      contract = findContract(event, it.instrument_symbol);
      if (!contract || event?.ticker !== it.event_ticker || contract.status !== "active" || contract.marketState !== "open") {
        reason = "Market unavailable for another attempt.";
        break;
      }
      const expiry = Date.parse(contract.expiryDate ?? event.expiryDate);
      if (Number.isFinite(expiry)) submitBefore = Math.min(submitBefore ?? Infinity, expiry - BUY_CUTOFF_MS);
    }
    if (submitBefore !== undefined && Date.now() >= submitBefore) { reason = "Market cutoff reached."; break; }
    const quote = quoteFor(contract, it.outcome)[buy ? "buy" : "sell"];
    if (!buy && quote === null) { reason = "No current bid."; break; }
    const price = buy ? limit : Math.floor(quote * 100 + 1e-9) / 100;
    if (!buy && price < limit) {
      reason = "Bid below the approved price floor.";
      break;
    }
    const costLeft = Math.max(0, Math.floor((maxCost - spent - fees) * 100 + 1e-8) / 100);
    const remaining = Number((target - filled).toFixed(8));
    const increment = num(contract.quantityIncrement);
    const sellable = increment !== null && increment > 0
      ? Number((Math.floor(remaining / increment + 1e-9) * increment).toFixed(8)) : remaining;
    const quantity = buy ? Math.min(Math.floor(remaining), budgetQuantity(costLeft, price)) : sellable;
    if (quantity <= 0 || quantity < (num(contract.quantityMinimum) ?? 0)) {
      reason = buy ? "Remaining budget or quantity is below the order minimum." : "Remaining quantity is below the order minimum.";
      break;
    }
    const fields = { symbol: it.instrument_symbol, side: it.side, outcome: it.outcome,
      orderType: "limit", timeInForce: "immediate-or-cancel", price: price.toFixed(2), quantity: String(quantity), makerOrCancel: false };
    await log("ORDER_SENT", caller, "Submitting market IOC attempt " + (attempt + 1), fields);
    const placed = await gPrivate("/v1/prediction-markets/order", fields, {submitBefore});
    if (placed.missedDeadline) { reason = "Market cutoff reached."; break; }
    let order = placed.data;
    let summary = classifyExchangeOrder(order, quantity, false);
    if (placed.ok && order?.orderId && summary === "PENDING_UNKNOWN") {
      const history = await gPrivate("/v1/prediction-markets/orders/history", {symbol: it.instrument_symbol, limit: 20});
      const match = history.data?.orders?.find(row => String(row.orderId) === String(order.orderId));
      if (history.ok && match) { order = match; summary = classifyExchangeOrder(order, quantity, false); }
    }
    attempts.push({ price, quantity, http_status: placed.status, order });
    if (!placed.ok) {
      uncertain = placed.status === 0 || placed.status === 408 || placed.status >= 500 || order?.reason === "DuplicateOrder";
      rejected = !uncertain;
      if (!buy && rejected && (order?.reason ?? order?.error) === "InsufficientLiquidity" && !attempt && order?.orderId == null) {
        rejected = false;
        continue;
      }
      if (rejected) reason = rejectionMessage(order, placed.status);
      break;
    }
    const amount = exchangeQuantity(order?.filledQuantity);
    if (order?.orderId == null || amount === null || amount < 0 || amount > quantity) {
      uncertain = true;
      break;
    }
    const average = num(order.avgExecutionPrice);
    const validAverage = average !== null && average > 0 && average < 1 && (buy ? average <= price + 1e-9 : average + 1e-9 >= price);
    if (amount > 0 && !validAverage) knownAverage = false;
    const charged = validAverage ? average : price;
    filled = Number((filled + amount).toFixed(8));
    spent += amount * charged;
    fees = round2(fees + feeEstimate(amount, charged));
    if (summary === "PENDING_UNKNOWN") { uncertain = true; break; }
    if (filled >= target) break;
    if (summary === "FILLED") { reason = "Remaining budget is below one contract."; break; }
    // A definitive cancelled order with intact exchange ID and fill count is
    // the only path to the second attempt.
    if (summary !== "PARTIAL" && summary !== "NOT_FILLED") break;
  }
  const ids = attempts.flatMap(a => a.order?.orderId == null ? [] : [String(a.order.orderId)]);
  const outcome = uncertain ? "PENDING_UNKNOWN" : filled >= target ? "FILLED" :
    filled > 0 ? "PARTIAL" : rejected ? "EXCHANGE_REJECTED" : "NOT_FILLED";
  const avg = knownAverage && filled > 0 ? spent / filled : null;
  const fillText = filled > 0 ? `Filled ${filled} of ${target} sandbox contracts${avg === null ? "" : " at an average of " + cents(avg)}.` :
    "No sandbox contracts filled.";
  if (!reason && !uncertain && filled < target) reason = "The remainder did not match at the attempted prices.";
  const say = uncertain
    ? (filled > 0 ? `At least ${filled} filled. ` : "") + "Final fill unknown. Check order history."
    : fillText + (reason ? " " + reason : "");
  const last = attempts.at(-1)?.order;
  const gross = filled > 0 && knownAverage ? round2(spent) : (filled === 0 && !uncertain ? 0 : null);
  const result = { side: it.side, ok: outcome !== "EXCHANGE_REJECTED", order_mode: "market", outcome_summary: outcome, say,
    voice_say: spokenBudgetFill(it, outcome, filled, avg) ?? spokenFill(outcome, filled, target, avg) ?? say,
    order_id: ids[0] ?? null, order_ids: ids, exchange_status: last?.status ?? null, filled_quantity: filled || (uncertain ? null : 0),
    remaining_quantity: uncertain ? null : Number((target - filled).toFixed(8)), avg_price: avg,
    filled_notional_usd: buy ? round2(spent) : 0, ...(!buy && {gross_proceeds_usd: gross}), est_fee_usd: fees };
  await saveOrder({ intent_id: it.id, side: it.side, gemini_order_id: result.order_id, outcome_summary: outcome,
    exchange_status: result.exchange_status, filled_qty: result.filled_quantity, remaining_qty: result.remaining_quantity,
    avg_price: avg, filled_notional_usd: result.filled_notional_usd, error: reason || null, raw: {attempts, result} });
  await finish(outcome === "EXCHANGE_REJECTED" ? "FAILED" : "DONE");
  await receipt(it.id, it.code, "result", result);
  await log("ORDER_" + outcome, caller, say, {order_ids: ids});
  return json(result);
}

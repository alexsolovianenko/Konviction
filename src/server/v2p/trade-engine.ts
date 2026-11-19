// @ts-nocheck -- shared with the mechanically ported phone backend.
import { contractTradable, findContract, getEvent, gPrivate, quoteFor } from "./gemini";
import { comboEligibility } from "./native-combo";
import { BUY_CUTOFF_MS, cents, feeEstimate, hashPhone, json, LIMITS, num, round2, speakTime, usd } from "./util";
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
  const availableCents = Math.min(Math.round(budget * 100), Math.floor(LIMITS.maxOrderUsd * 100 + 1e-8));
  const priceCents = Math.round(limit * 100);
  let high = Math.min(Math.floor(LIMITS.maxQuantity), Math.floor(availableCents / priceCents));
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
  if (side === "buy" && expiryIso && Date.parse(expiryIso) - Date.now() <= BUY_CUTOFF_MS)
    return err("TOO_CLOSE_TO_EXPIRY", "Ten seconds or less remain in this market.");
  const q = quoteFor(c, outcome as "yes" | "no");
  const label = c.label ?? c.ticker ?? symbol;
  const outcomeText = outcome === "yes" ? `YES (${label})` : `NO (not ${label})`;

  let quantity: number, limit: number, quotePrice: number;
  if (side === "buy") {
    if (q.buy === null)
      return err(
        "NO_LIQUIDITY",
        "Gemini shows no buy price for this outcome. Check for a fresh quote or choose another contract.",
      );
    quotePrice = q.buy;
    limit = priceLimitIn ?? q.buy;
    if (limit < LIMITS.minLimitPrice || limit > LIMITS.maxLimitPrice)
      return err("LIMIT_PRICE_CAP", `The order limit must be between 1¢ and ${cents(LIMITS.maxLimitPrice)}.`, { max_price: LIMITS.maxLimitPrice });
    if (qtyIn !== null) {
      quantity = Math.floor(qtyIn);
    } else if (budget !== null) {
      quantity = budgetQuantity(budget, limit);
    } else {
      return err(
        "BAD_INPUT",
        "Ask whether the caller means a dollar amount or a number of contracts.",
      );
    }
  } else {
    // SELL: only what we hold and is not on hold.
    const pos = await gPrivate("/v1/prediction-markets/positions");
    if (!pos.ok)
      return err("EXCHANGE_ERROR", "Couldn't read positions from Gemini. Nothing was prepared.", {
        detail: pos.error ?? pos.text.slice(0, 200),
      });
    // deno-lint-ignore no-explicit-any
    const p = (pos.data?.positions ?? []).find(
      (x: any) => x.symbol === symbol && String(x.outcome).toLowerCase() === outcome,
    );
    const available = p
      ? Math.floor((num(p.totalQuantity) ?? 0) - (num(p.quantityOnHold) ?? 0))
      : 0;
    if (available <= 0)
      return err(
        "INSUFFICIENT_POSITION",
        "There's no position in that contract and outcome to sell.",
      );
    if (q.sell === null)
      return err(
        "NO_BID",
        "Nobody is bidding for this right now, so it can't be sold immediately. Nothing was prepared.",
      );
    quotePrice = q.sell;
    limit = round2(priceLimitIn !== null ? priceLimitIn : q.sell);
    if (limit > q.sell) {
      return err(
        "PRICE_BELOW_YOUR_MIN",
        `The best bid is ${cents(q.sell)}, below the caller's minimum of ${cents(limit)}. Selling now at their minimum would not fill.`,
        { current_bid: q.sell },
      );
    }
    quantity = qtyIn !== null ? Math.floor(qtyIn) : available;
    if (quantity > available)
      return err("INSUFFICIENT_POSITION", `Only ${available} contracts are available to sell.`, {
        available,
      });
  }

  if (!Number.isFinite(quantity) || quantity < 1)
    return err("CAP_EXCEEDED", "That amount is too small to buy even one contract at this price.");
  const minimum = num(c.quantityMinimum);
  if (minimum !== null && quantity < minimum)
    return err("BELOW_CONTRACT_MINIMUM", `Gemini requires at least ${minimum} contracts for this market. Your order sizes to ${quantity}. Choose another contract or request a new size.`);
  if (quantity > LIMITS.maxQuantity)
    return err("CAP_EXCEEDED", `Demo limit is ${LIMITS.maxQuantity} contracts per order.`);
  const notional = round2(quantity * limit);
  const fee = feeEstimate(quantity, limit);
  if (side === "buy" && notional + fee > LIMITS.maxOrderUsd + 1e-9) {
    return err(
      "CAP_EXCEEDED",
      `Demo limit is ${usd(LIMITS.maxOrderUsd)} per order including fees. This would be ${usd(notional + fee)}.`,
    );
  }
  const expiresAt = new Date(Date.now() + LIMITS.intentTtlSeconds * 1000).toISOString();
  const readback =
    side === "buy"
      ? `Buy ${quantity} ${outcomeText} contracts on "${event.title}", expiring ${speakTime(expiryIso)}, at up to ${cents(limit)} each. That's at most ${usd(notional)} plus an estimated ${usd(fee)} fee. Only what fills immediately at or under that price is bought; the rest is cancelled.`
      : `Sell ${quantity} ${outcomeText} contracts on "${event.title}" at no less than ${cents(limit)} each — about ${usd(notional)} before an estimated ${usd(fee)} fee. Only what sells immediately is sold.`;

  return saveProposal({
    side,
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
  // The signed IOC limit caps the exchange price even if the ask changes between
  // this snapshot and matching. A buy below the current ask can still be tried.
  if (it.side === "sell" && (q.sell === null || q.sell < limit - 1e-9)) {
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
  const submitBefore = it.side === "buy" && expiry ? Date.parse(expiry) - BUY_CUTOFF_MS : undefined;
  if (submitBefore !== undefined && Date.now() >= submitBefore) {
    await finish("REJECTED");
    return err("TOO_CLOSE_TO_EXPIRY", "Ten seconds or less remain in this market.");
  }
  const callerHash = await hashPhone(caller);
  await receipt(it.id, code, "approval", {
    caller_hash: callerHash,
    side: it.side,
    instrument_symbol: it.instrument_symbol,
    outcome: it.outcome,
    quantity: it.quantity,
    limit_price: limit,
    approved_at: new Date().toISOString(),
    quote_at_execution: it.side === "buy" ? q.buy : q.sell,
  });

  // Place ONE immediate-or-cancel limit order. Never retried on timeout.
  const orderFields = {
    symbol: it.instrument_symbol,
    orderType: "limit",
    side: it.side,
    outcome: it.outcome,
    quantity: String(it.quantity),
    price: limit.toFixed(2),
    timeInForce: "immediate-or-cancel",
    makerOrCancel: false,
  };
  await log(
    "ORDER_SENT",
    caller,
    `${code}: sending IOC ${it.side} ${it.quantity} ${it.outcome} @ ${limit.toFixed(2)}`,
    orderFields,
  );
  const placed = await gPrivate("/v1/prediction-markets/order", orderFields, { submitBefore });
  if (placed.missedDeadline) {
    await finish("REJECTED");
    return err("TOO_CLOSE_TO_EXPIRY", "Ten seconds or less remained before submission.");
  }

  let summary: "FILLED" | "PARTIAL" | "NOT_FILLED" | "PENDING_UNKNOWN" | "EXCHANGE_REJECTED";
  // deno-lint-ignore no-explicit-any
  let o: any = placed.data;
  if (placed.status === 0 || placed.status === 408 || placed.status >= 500) {
    summary = "PENDING_UNKNOWN";
  } else if (!placed.ok) {
    summary = "EXCHANGE_REJECTED";
  } else {
    // The placement response can precede matching. Reconcile once by the exact order id.
    const terminal = (order: any) => ["filled", "cancelled", "canceled", "closed"].includes(String(order?.status ?? "").toLowerCase());
    if (o?.orderId && (num(o.filledQuantity) === null || (!terminal(o) && Number(o.filledQuantity) < it.quantity))) {
      await new Promise((r) => setTimeout(r, 1500));
      const h = await gPrivate("/v1/prediction-markets/orders/history", {
        symbol: it.instrument_symbol,
        limit: 20,
      });
      // deno-lint-ignore no-explicit-any
      const match = (h.data?.orders ?? []).find(
        (x: any) => String(x.orderId) === String(o.orderId),
      );
      if (match) o = match;
    }
    const filled = num(o?.filledQuantity) ?? 0;
    summary =
      num(o?.filledQuantity) === null || filled < 0 || filled > Number(it.quantity) + 1e-9 ||
      (filled < it.quantity && !terminal(o))
        ? "PENDING_UNKNOWN"
        : filled <= 0
          ? "NOT_FILLED"
          : filled + 1e-9 >= it.quantity
            ? "FILLED"
            : "PARTIAL";
  }

  const filledQty = num(o?.filledQuantity);
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
    FILLED: `Filled ${filledQty} sandbox contracts${average}.`,
    PARTIAL: `Filled ${filledQty} of ${it.quantity} sandbox contracts${average}. ${cancelled
      ? "The exchange cancelled the remainder. Request a fresh quote for the unfilled amount."
      : "Check order history for the remainder before placing another order."}`,
    NOT_FILLED: cancelled
      ? `Zero of ${it.quantity} contracts filled at your ${cents(limit)} limit. Gemini cancelled the immediate-or-cancel order. Request a fresh quote before trying again.`
      : "Gemini reports zero fills so far. Check order history before placing another order.",
    PENDING_UNKNOWN: filledQty !== null && filledQty > 0 && filledQty <= it.quantity
      ? `Gemini reports ${filledQty} filled so far. Check order history for the final quantity before placing another order.`
      : "Gemini has not confirmed the final fill. Check order history before placing another order.",
    EXCHANGE_REJECTED: rejection,
  };
  return json({
    ok: summary !== "EXCHANGE_REJECTED",
    outcome_summary: summary,
    order_id: o?.orderId ? String(o.orderId) : null,
    exchange_status: o?.status ?? null,
    filled_quantity: filledQty,
    remaining_quantity: num(o?.remainingQuantity),
    avg_price: avg,
    est_fee_usd: fillFee,
    say: say[summary],
    ...(summary === "EXCHANGE_REJECTED" && { voice_say: typeof reason === "string" && Object.hasOwn(voiceReasons, reason) ? voiceReasons[reason] : "Rejected. Check order details." }),
  });
}

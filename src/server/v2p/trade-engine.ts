// @ts-nocheck -- shared with the mechanically ported phone backend.
import { contractTradable, findContract, getEvent, gPrivate, quoteFor } from "./gemini";
import { cents, feeEstimate, hashPhone, json, LIMITS, num, round2, speakTime, usd } from "./util";
type Body = Record<string, any>;
const err = (error: string, message: string, extra = {}) =>
  json({ ok: false, error, message, ...extra });

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
      "Couldn't get a fresh quote from Gemini. Nothing was prepared.",
      { detail: error },
    );
  const c = findContract(event, symbol);
  if (!c || event.ticker !== eventTicker)
    return err("BAD_INPUT", "That contract isn't in this event. Call find_market again.");
  if (!contractTradable(c) || !c.status || !c.marketState)
    return err("CONTRACT_NOT_OPEN", "That contract isn't open for trading.");
  const expiryIso = c.expiryDate ?? event.expiryDate ?? null;
  const minutesLeft = expiryIso ? (Date.parse(expiryIso) - Date.now()) / 60000 : Infinity;
  const q = quoteFor(c, outcome as "yes" | "no");
  const label = c.label ?? c.ticker ?? symbol;
  const outcomeText = outcome === "yes" ? `YES (${label})` : `NO (not ${label})`;

  let quantity: number, limit: number, quotePrice: number;
  if (side === "buy") {
    if (minutesLeft < LIMITS.minMinutesToExpiry) {
      return err(
        "TOO_CLOSE_TO_EXPIRY",
        `This contract closes in under ${LIMITS.minMinutesToExpiry} minutes. Offer the next one.`,
      );
    }
    if (q.buy === null)
      return err(
        "NO_LIQUIDITY",
        "Nobody is selling this outcome right now, so a buy can't fill. Offer another contract.",
      );
    quotePrice = q.buy;
    limit =
      priceLimitIn !== null ? priceLimitIn : round2(Math.min(q.buy + 0.01, LIMITS.maxLimitPrice));
    limit = round2(Math.min(limit, LIMITS.maxLimitPrice));
    if (limit < LIMITS.minLimitPrice) return err("BAD_INPUT", "Price must be at least 1 cent.");
    if (limit < q.buy) {
      return err(
        "PRICE_ABOVE_YOUR_MAX",
        `The current price is ${cents(q.buy)}, above the caller's maximum of ${cents(limit)}. An order at that price would not fill now. Ask if they want to pay up to ${cents(Math.min(round2(q.buy + 0.01), LIMITS.maxLimitPrice))}.`,
        { current_price: q.buy },
      );
    }
    if (qtyIn !== null) {
      quantity = Math.floor(qtyIn);
    } else if (budget !== null) {
      const per = limit + LIMITS.takerRate * limit * (1 - limit);
      quantity = Math.floor(budget / per);
      while (quantity > 0 && quantity * limit + feeEstimate(quantity, limit) > budget + 1e-9)
        quantity--;
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
    return err("CONTRACT_NOT_OPEN", "The contract closed. Nothing was placed.");
  }
  const q = quoteFor(c, it.outcome);
  const limit = Number(it.limit_price);
  const quoted = Number(it.quote_price);
  if (it.side === "buy") {
    if (
      q.buy === null ||
      q.buy > limit + 1e-9 ||
      q.buy - quoted > LIMITS.priceMoveTolerance + 1e-9
    ) {
      await finish("REJECTED");
      await log("PRICE_MOVED", caller, `${code}: ask now ${q.buy ?? "none"} vs limit ${limit}`);
      return err(
        "PRICE_MOVED",
        `The price moved${q.buy !== null ? ` to ${cents(q.buy)}` : " (no sellers now)"}. Nothing was placed. Offer to prepare a new trade at the new price.`,
        { current_price: q.buy },
      );
    }
  } else if (q.sell === null || q.sell < limit - 1e-9) {
    await finish("REJECTED");
    await log("PRICE_MOVED", caller, `${code}: bid now ${q.sell ?? "none"} vs min ${limit}`);
    return err(
      "PRICE_MOVED",
      `The bid moved${q.sell !== null ? ` to ${cents(q.sell)}` : " (no buyers now)"}. Nothing was sold. Offer to prepare a new sell.`,
      { current_bid: q.sell },
    );
  }

  if (
    it.side === "buy" &&
    c.expiryDate &&
    Date.parse(c.expiryDate) - Date.now() < LIMITS.minMinutesToExpiry * 60000
  ) {
    await finish("REJECTED");
    return err("TOO_CLOSE_TO_EXPIRY", "The contract is too close to expiry.");
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
  const placed = await gPrivate("/v1/prediction-markets/order", orderFields);

  let summary: "FILLED" | "PARTIAL" | "NOT_FILLED" | "PENDING_UNKNOWN" | "EXCHANGE_REJECTED";
  // deno-lint-ignore no-explicit-any
  let o: any = placed.data;
  if (placed.status === 0 || placed.status >= 500) {
    summary = "PENDING_UNKNOWN";
  } else if (!placed.ok) {
    summary = "EXCHANGE_REJECTED";
  } else {
    // If fill fields are missing, check order history once (by orderId) instead of guessing.
    if (o?.orderId && o.filledQuantity === undefined) {
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
      num(o?.filledQuantity) === null
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
  const say: Record<string, string> = {
    FILLED: `Filled: ${filledQty} contracts${avg !== null ? ` at an average of ${cents(avg)}` : ""}.`,
    PARTIAL: `Partly filled: ${filledQty} of ${it.quantity} contracts${avg !== null ? ` at an average of ${cents(avg)}` : ""}. Gemini reports status ${o?.status ?? "unknown"}.`,
    // Only say "cancelled" when Gemini itself reports it (david 8d1e9d4).
    NOT_FILLED: String(o?.status ?? "").toLowerCase() === "cancelled"
      ? `Gemini accepted the order but nothing filled at that price, so it was cancelled. No money was spent and no position was opened.`
      : `Gemini accepted the order${o?.orderId ? ` (order ${o.orderId})` : ""} but reports nothing filled yet (status: ${o?.status ?? "unknown"}). Do not say it filled or was cancelled; check open orders.`,
    PENDING_UNKNOWN: `Gemini did not confirm the fill status. Check open orders and recent order history before taking further action.`,
    EXCHANGE_REJECTED: `Gemini rejected the order, so nothing was placed.`,
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
    exchange_error: placed.ok ? undefined : (placed.error ?? placed.text.slice(0, 300)),
  });
}

import { gPrivate } from "./gemini";
import { classifyExchangeOrder } from "./trade-engine";

interface OpenOrder {
  side?: string; intent_id: string; gemini_order_id: string; instrument_symbol: string; quantity: number; limit_price: number;
}
interface ExchangeOrder {
  orderId: string; symbol: string; status: string; filledQuantity: string | number;
  remainingQuantity?: string | number; avgExecutionPrice?: string | number;
}

export async function settledOpenOrders(open: OpenOrder[], history?: ExchangeOrder[]) {
  if (!open.length) return [];
  if (!history) {
    const result = await gPrivate("/v1/prediction-markets/orders/history", {}, { query: { limit: 100 } });
    if (!result.ok || !Array.isArray(result.data?.orders)) return [];
    history = result.data.orders as ExchangeOrder[];
  }
  const byId = new Map(history.map(row => [String(row.orderId), row]));
  return open.flatMap(order => {
    const row = byId.get(String(order.gemini_order_id));
    if (!row || row.symbol !== order.instrument_symbol) return [];
    const quantity = Number(order.quantity);
    const summary = classifyExchangeOrder(row, quantity);
    if (!["FILLED", "PARTIAL", "NOT_FILLED"].includes(summary)) return [];
    const filled = Number(row.filledQuantity);
    const avg = Number(row.avgExecutionPrice);
    const knownAverage = Number.isFinite(avg) && avg > 0 && avg < 1 && (order.side === "sell" ? avg >= Number(order.limit_price) : avg <= Number(order.limit_price));
    return [{ intent_id: order.intent_id, exchange_status: row.status, outcome_summary: summary,
      filled_qty: filled, remaining_qty: Number.isFinite(Number(row.remainingQuantity)) ? Number(row.remainingQuantity) : null,
      avg_price: knownAverage ? avg : null,
      filled_notional_usd: order.side === "sell" ? 0 : Math.ceil((filled * (knownAverage ? avg : Number(order.limit_price)) - 1e-9) * 100) / 100 }];
  });
}

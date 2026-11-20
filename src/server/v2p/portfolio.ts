import { marketTitle } from "./market-title";
import { gPrivate } from "./gemini";

const fields = {
  orders: ["orderId", "symbol", "side", "outcome", "status", "quantity", "price", "filledQuantity", "remainingQuantity", "avgExecutionPrice", "createdAt", "updatedAt"],
  positions: ["symbol", "outcome", "totalQuantity", "quantityOnHold", "avgPrice", "marketValue", "unrealizedPnl", "realizedPl", "netProfit", "markPrice"],
  settlements: ["symbol", "outcome", "resolutionSide", "positionQuantity", "netProfit", "payout", "settledAt"],
};

async function accountSection(path: string, kind: keyof typeof fields) {
  const settled = kind === "settlements";
  const r = await gPrivate("/v1/prediction-markets/" + path, {}, settled ? { query: { limit: 20 } } : {});
  const rows: unknown = r.data?.[settled ? "positions" : kind];
  if (!r.ok || !Array.isArray(rows)) return { error: "Gemini Sandbox data unavailable.", rows: [] };
  return {
    rows: rows.slice(0, settled ? 20 : 100).map(row => {
      const result: Record<string, string | number> = {};
      for (const key of fields[kind]) {
        if (typeof row?.[key] === "string" || typeof row?.[key] === "number") result[key] = row[key];
      }
      const metadata = row?.contractMetadata;
      if (typeof metadata?.eventName === "string") result["event_title"] = marketTitle(metadata.eventName, metadata.expiryDate);
      if (typeof metadata?.contractName === "string") result["contract_label"] = marketTitle(metadata.contractName, metadata.expiryDate);
      if (kind === "positions" && ["yes", "no"].includes(String(row?.outcome).toLowerCase())) {
        const bid = row.prices?.sell?.[row.outcome.toLowerCase()];
        if (typeof bid === "string" || typeof bid === "number") result["current_bid"] = bid;
      }
      return result;
    }),
  };
}

export async function sandboxPortfolio() {
  const [orders, positions, history, settlements] = await Promise.all([
    accountSection("orders/active", "orders"),
    accountSection("positions", "positions"),
    accountSection("orders/history", "orders"),
    accountSection("positions/settled", "settlements"),
  ]);
  return { ok: true, as_of: new Date().toISOString(), source: "Gemini Sandbox", orders, positions, history, settlements };
}

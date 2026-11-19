import { isValidBuySize } from "./trade-engine";

const symbol = /^[A-Z0-9][A-Z0-9_.-]{0,99}$/;

export function validOrderKeys(input: Record<string, unknown> | null): string[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const side = Object.hasOwn(input, "side") ? input["side"] : "buy";
  if (side !== "buy" && side !== "sell") return null;
  const size = side === "sell" && Object.hasOwn(input, "close_all") ? "close_all"
    : side === "buy" && Object.hasOwn(input, "budget_usd") ? "budget_usd" : "quantity";
  const keys = ["event_ticker", "contract_symbol", "outcome", size];
  for (const key of ["limit_price", "order_mode", "side"]) if (Object.hasOwn(input, key)) keys.push(key);
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return null;
  if (![input["event_ticker"], input["contract_symbol"]].every(key => typeof key === "string" && symbol.test(key))) return null;
  if (input["outcome"] !== "yes" && input["outcome"] !== "no") return null;
  if (keys.includes("order_mode") && input["order_mode"] !== "limit" && input["order_mode"] !== "market") return null;
  if (side === "buy" && !isValidBuySize(input)) return null;
  if (side === "sell" && (size === "close_all" ? input["close_all"] !== true :
      typeof input["quantity"] !== "number" || !Number.isFinite(input["quantity"]) || input["quantity"] <= 0)) return null;
  const price = input["limit_price"];
  if (keys.includes("limit_price") && (typeof price !== "number" || !Number.isFinite(price) ||
    price < 0.01 || price > 0.99 || Math.abs(Math.round(price * 100) - price * 100) > 1e-8)) return null;
  return keys;
}

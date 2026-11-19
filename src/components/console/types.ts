export type Position = {
  symbol: string; outcome: string; quantity: number; on_hold: number; avg_price: number | null; bid: number | null;
  market_value: number | null; unrealized_pnl: number | null; event: string | null; contract: string | null;
  contract_status: string | null; expiry: string | null; resolution_side: string | null;
};
export type Activity = { id: string; at: string; kind: string; caller: string | null; summary: string; detail: unknown };
export type Intent = {
  id: string; code: string; caller: string | null; side: string; title: string | null; contract_label: string | null;
  instrument_symbol: string | null; outcome: string; quantity: number; limit_price: number; notional_usd: number | null;
  est_fee_usd: number | null; quote_price: number | null; status: string; expires_at: string; created_at: string;
};
export type Order = {
  id: string; intent_id: string; side: string; gemini_order_id: string | null; outcome_summary: string | null;
  exchange_status: string | null; filled_qty: number | null; remaining_qty: number | null; avg_price: number | null;
  error: string | null; raw: unknown; created_at: string;
};
export type Receipt = {
  id: string; intent_id: string | null; kind: string; payload_text: string; sha256: string;
  solana_sig: string | null; error: string | null; created_at: string;
};
export type MarketQuote = { yes: number | null; no: number | null };
export type MarketContract = {
  symbol: string; label: string | null; status: string | null; market_state: string | null;
  expiry: string | null; buy: MarketQuote; sell: MarketQuote;
};
export type MarketEvent = {
  ticker: string; title: string; category: string | null; status: string | null; contracts: MarketContract[];
};
export type MarketsSnapshot = { events: MarketEvent[]; error: string | null };
export type DashboardState = {
  history_available?: boolean;
  generated_at: string; environment: string; phone_number: string | null; execution_enabled: boolean;
  limits: { maxOrderUsd: number; maxDailyUsd: number; maxLimitPrice: number; maxQuantity: number; intentTtlSeconds: number };
  account: {
    configured: boolean; terms_accepted: boolean | null; usd_available: number | null; positions: Position[];
    terms_error: string | null; balance_error: string | null; positions_error: string | null;
  };
  solana: { address: string | null; balance_sol: number | null } | null;
  markets?: MarketsSnapshot;
  activity: Activity[]; intents: Intent[]; orders: Order[]; receipts: Receipt[];
};

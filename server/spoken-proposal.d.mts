export function spokenProposal(terms: {
  budget_usd?: number;
  order_mode?: string;
  contract_expiry?: string | null;
  event_ticker?: string;
  side?: string;
  quantity: number;
  outcome: string;
  title: string;
  contract_label: string;
  limit_price: number;
  notional_usd: number;
  est_fee_usd: number;
}): string;

export function hasSpokenMarketName(terms: {title?: string; contract_label?: string; event_ticker?: string; instrument_symbol?: string}): boolean;
export function normalizeReadback(value: string): string;

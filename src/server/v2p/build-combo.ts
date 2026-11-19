import { findContract, getEvent, gPrivate, gPublic, quoteFor } from "./gemini";
import { eligibleComboLegs } from "./native-combo";

type RequestedLeg = { event_ticker: string; contract_symbol: string; outcome: "yes" | "no" };
type ResolvedLeg = RequestedLeg & { id: string; title: string; label: string; expiry: string };

const fail = (error: string, say: string) => ({ ok: false, error, say });
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9_.-]{0,159}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function validLeg(leg: unknown): leg is RequestedLeg {
  return record(leg) && Object.keys(leg).length === 3 && identifier(leg["event_ticker"]) &&
    identifier(leg["contract_symbol"]) && (leg["outcome"] === "yes" || leg["outcome"] === "no");
}

async function resolveLeg(leg: RequestedLeg): Promise<ResolvedLeg | null> {
  const { event } = await getEvent(leg.event_ticker);
  const c = findContract(event, leg.contract_symbol);
  if (event?.ticker !== leg.event_ticker || event.status !== "active" || !event.title ||
      !c?.id || !c.label || c.isCombo || /^GEMI-CMB-/i.test(leg.contract_symbol) ||
      c.status !== "active" || c.resolutionSide || !c.expiryDate || !(Date.parse(c.expiryDate) > Date.now())) return null;

  // The events feed exposes eventId-contractId. The combo endpoint requires just the contract ID.
  const ids = /^(\d+)-(\d+)$/.exec(c.id);
  const id = ids && ids[1] === String(event.id) ? ids[2] : /^\d+$/.test(c.id) ? c.id : null;
  return id ? { ...leg, id, title: event.title, label: c.label, expiry: c.expiryDate } : null;
}

function exactLegSet(returned: unknown, requested: ResolvedLeg[], verifyInstruments = false) {
  if (!Array.isArray(returned) || returned.length !== requested.length) return false;
  return requested.every(wanted => returned.some(r => r && String(r.contractId) === wanted.id &&
    r.requiredOutcome === (wanted.outcome === "yes" ? "Yes" : "No") && (!verifyInstruments ||
      (r.contract?.eventTicker === wanted.event_ticker && r.contract?.instrumentSymbol === wanted.contract_symbol))));
}

async function findListedCombo(legs: ResolvedLeg[]): Promise<string | null> {
  let offset = 0;
  while (true) {
    const result = await gPublic("/v1/prediction-markets/combos", {
      contractId: legs[0]!.id, status: "Active", instrumentRegistered: "true", limit: 100, offset,
    });
    const combos = result.data?.combos;
    if (!result.ok || !Array.isArray(combos)) return null;
    const match = combos.find(c => exactLegSet(c?.legs, legs, true));
    if (identifier(match?.contract?.instrumentSymbol)) return match.contract.instrumentSymbol;
    offset += combos.length;
    if (!combos.length || !(offset < result.data?.pagination?.total)) return null;
  }
}

export async function buildSandboxCombo(body: unknown) {
  if (!record(body) || Object.keys(body).length !== 1 || !Array.isArray(body["legs"]) ||
      body["legs"].length < 2 || body["legs"].length > 6 || !body["legs"].every(validLeg) ||
      new Set(body["legs"].map(l => l.contract_symbol)).size !== body["legs"].length)
    return fail("INVALID_COMBO_LEGS", "Choose two to six distinct predictions.");

  const found = await Promise.all(body["legs"].map(resolveLeg));
  if (!found.every((l): l is ResolvedLeg => l !== null) || new Set(found.map(l => l.id)).size !== found.length)
    return fail("INELIGIBLE_COMBO_LEG", "One of those predictions is unavailable.");

  // Canonical registration creates only the instrument. The normal confirmed trade route places orders.
  const created = await gPrivate("/v1/prediction-markets/combos", {
    legs: found.map(l => ({ contractId: l.id, requiredOutcome: l.outcome === "yes" ? "Yes" : "No" })),
  }, { jsonBody: true });
  let symbol: string;
  if (created.ok) {
    const combo = created.data?.combo;
    if (!exactLegSet(combo?.legs, found)) return fail("COMBO_MISMATCH", "Gemini couldn't verify those exact predictions.");
    if (combo.instrumentRegistered !== true || !identifier(combo.instrumentSymbol))
      return fail("COMBO_UNREGISTERED", "This combination is awaiting registration.");
    symbol = combo.instrumentSymbol;
  } else {
    // Canonical listings may already exist even when Gemini declines registration by this account.
    const existing = await findListedCombo(found);
    if (existing) symbol = existing;
    else if (created.status === 401 || created.status === 403)
      return fail("COMBO_PERMISSION", "This account cannot create that combination.");
    else if (created.status === 400 || created.status === 422)
      return fail("COMBO_REJECTED", "Gemini cannot combine those predictions.");
    else return fail("COMBO_UNAVAILABLE", "Combo creation unavailable.");
  }

  const detail = await gPublic("/v1/prediction-markets/combos/" + encodeURIComponent(symbol));
  const meta = detail.data?.contract;
  if (!detail.ok || meta?.instrumentSymbol !== symbol || !identifier(meta.eventTicker) ||
      meta.contractStatus?.toLowerCase() !== "active" || meta.resolutionSide || meta.resolvedAt ||
      !exactLegSet(detail.data.legs, found, true) || !eligibleComboLegs(detail.data.legs))
    return fail("COMBO_UNAVAILABLE", "This combination is unavailable for trading.");

  const { event } = await getEvent(meta.eventTicker);
  const c = findContract(event, symbol);
  if (event?.ticker !== meta.eventTicker || event?.status !== "active" || !event?.title || !c?.isCombo || c.status !== "active" ||
      c.resolutionSide || !c.expiryDate || Date.parse(c.expiryDate) !== Date.parse(meta.expiryDate) || !(Date.parse(c.expiryDate) > Date.now()))
    return fail("COMBO_UNAVAILABLE", "This combination is unavailable for trading.");
  const price = c.marketState === "open" ? quoteFor(c, "yes").buy : null;
  const cents = price === null ? null : Number((price * 100).toFixed(3));
  return { ok: true, quoted: price !== null, event_ticker: event.ticker, contract_symbol: symbol, title: event.title,
    legs: found.map(({ title, label, expiry, outcome }) => ({ title, label, expiry, outcome })),
    buy_price: price, implied_percent: cents, payout_per_winning_contract_usd: 1,
    as_of: new Date().toISOString(), say: price === null ? "There’s no price for that combination yet."
      : `The combined price is ${cents} cents, about ${cents}% market-implied odds.` };
}

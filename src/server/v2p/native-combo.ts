import { gPublic, type Contract, type GEvent } from "./gemini";

type Leg = {
  requiredOutcome?: string;
  legOutcome?: string | null;
  resolvedAt?: string | null;
  contract?: {
    instrumentSymbol?: string;
    contractStatus?: string;
    expiryDate?: string;
    resolutionSide?: string | null;
  };
};

function legState(leg: Leg, now: number) {
  const contract = leg?.contract;
  if (!contract?.instrumentSymbol || /^GEMI-CMB-/i.test(contract.instrumentSymbol) ||
      !["Yes", "No"].includes(leg.requiredOutcome ?? "")) return "ineligible";
  const status = contract.contractStatus?.toLowerCase();
  if (status === "active" && !leg.legOutcome && !leg.resolvedAt && !contract.resolutionSide &&
      Date.parse(contract.expiryDate ?? "") > now) return "pending";
  if (status !== "settled" || contract.resolutionSide?.toLowerCase() !== leg.requiredOutcome?.toLowerCase()) return "ineligible";
  // Current sandbox reports Pass/Fail; the published REST schema also supports Yes/No.
  if (leg.legOutcome != null && leg.legOutcome !== "Pass" && leg.legOutcome !== leg.requiredOutcome) return "ineligible";
  return "passed";
}

export function eligibleComboLegs(legs: unknown, now = Date.now()) {
  if (!Array.isArray(legs) || legs.length < 2 || legs.length > 6) return false;
  if (new Set(legs.map((leg: Leg) => leg?.contract?.instrumentSymbol)).size !== legs.length) return false;
  const states = legs.map((leg: Leg) => legState(leg, now));
  return states.includes("pending") && !states.includes("ineligible");
}

/** Validate the native instrument before exposing its prices or submitting to its own book. */
export async function comboEligibility(event: GEvent, contract: Contract) {
  const symbol = contract.instrumentSymbol ?? "";
  if (!contract.isCombo && !/^GEMI-CMB-/i.test(symbol) && !/^CMB-/i.test(event.ticker ?? "")) return null;
  if (contract.isCombo !== true || !symbol || event.status?.toLowerCase() !== "active" ||
      contract.status !== "active" || contract.marketState !== "open") return "This combo is not open.";
  const data = await gPublic("/v1/prediction-markets/combos/" + encodeURIComponent(symbol));
  if (!data.ok) return "Gemini could not verify this combo.";
  const metadata = data.data?.contract;
  const now = Date.now();
  const expiry = Date.parse(contract.expiryDate ?? "");
  if (metadata?.instrumentSymbol !== symbol || metadata.eventTicker !== event.ticker ||
      metadata.contractStatus?.toLowerCase() !== "active" || metadata.resolutionSide || metadata.resolvedAt ||
      !(expiry > now) || expiry !== Date.parse(metadata.expiryDate ?? "") ||
      !eligibleComboLegs(data.data?.legs, now)) return "This combo is unavailable for trading.";
  return null;
}

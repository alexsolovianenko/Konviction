import { confirmedInCall } from "../call-confirmation";

export function approvedResearch(history: unknown, quoteId: string, offer: string): boolean {
  return confirmedInCall(history, {
    toolNames: ["request_research_quote"], idField: "quote_id", id: quoteId, readback: offer, research: true,
  });
}

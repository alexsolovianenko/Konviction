import { phoneAccount } from "../phone/accounts";
import { confirmedInCall } from "../call-confirmation";

export function approvedResearch(history: unknown, quoteId: string, offer: string): boolean {
  return confirmedInCall(history, {
    toolNames: [phoneAccount.getStore() ? "phone_request_research_quote" : "request_research_quote"], idField: "quote_id", id: quoteId, readback: offer, research: true,
  });
}

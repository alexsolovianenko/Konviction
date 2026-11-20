import { confirmedInCall } from "../call-confirmation";

export function approvedResearch(history: unknown, quoteId: string, offer: string, channel: "phone" | "browser" = "browser"): boolean {
  return confirmedInCall(history, {
    toolNames: [channel === "phone" ? "phone_request_research_quote" : "request_research_quote"], idField: "quote_id", id: quoteId, readback: offer, research: true,
  });
}

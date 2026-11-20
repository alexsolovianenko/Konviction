import { normalizeReadback } from "../../../../server/spoken-proposal.mjs";
import { isSpokenConfirmation } from "../../../spoken-confirmation";

// A research yes belongs only to the immediately preceding, uninterrupted price offer.
export function approvedResearch(history: unknown, quoteId: string, offer: string): boolean {
  if (typeof history !== "string") return false;
  try {
    const { entries } = JSON.parse(history);
    let stage = 0;
    for (const turn of entries) {
      for (const tool of ["agent", "tool"].includes(turn.role) ? turn.tool_results ?? [] : []) {
        stage = 0;
        if (tool.tool_name !== "request_research_quote" || tool.is_error) continue;
        const data = typeof tool.result_value === "string" ? JSON.parse(tool.result_value) : tool.result_value;
        if (data?.ok && data.quote_id === quoteId) stage = 1;
      }
      if (turn.role === "tool" || !turn.message?.trim()) continue;
      if (stage === 1 && turn.role === "agent" && !turn.interrupted &&
          normalizeReadback(turn.message) === normalizeReadback(offer)) stage = 2;
      else if (stage === 2 && turn.role === "user" && isSpokenConfirmation(turn.message)) stage = 3;
      else stage = 0;
    }
    return stage === 3;
  } catch { return false; }
}

import { isSpokenConfirmation } from "../../spoken-confirmation";
import { normalizeReadback } from "../../../server/spoken-proposal.mjs";

export function confirmedInCall(history: unknown, terms: {
  toolNames: readonly string[];
  idField: string;
  id: string;
  readback: string;
  immediateBuy?: boolean;
  research?: boolean;
}): boolean {
  if (typeof history !== "string") return false;
  try {
    const { entries } = JSON.parse(history);
    if (!Array.isArray(entries)) return false;
    let bound = false;
    let steps = 0;
    const expected = terms.readback;
    for (const turn of entries) {
      for (const result of turn.role === "tool" || turn.role === "agent" ? turn.tool_results ?? [] : []) {
        if (!terms.toolNames.includes(result.tool_name)) {
          if (terms.research) { bound = false; steps = 0; }
          continue;
        }
        // An interrupted preparation returns a plain-text error. Only its own attempt is invalid.
        bound = false;
        steps = 0;
        if (result.is_error) continue;
        let data = result.result_value;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch { continue; }
        }
        bound = data?.ok === true && data[terms.idField] === terms.id;
      }
      if (typeof turn.message !== "string" || !turn.message.trim()) continue;
      if (turn.role === "tool") continue;
      if (turn.role === "agent" && bound && !turn.interrupted && normalizeReadback(turn.message) === normalizeReadback(expected)) steps = 2;
      else if (turn.role === "user" && steps === 2 && isSpokenConfirmation(turn.message, terms.immediateBuy)) steps = 3;
      else {
        steps = 0;
        // A status question or hesitation can be followed by a fresh, exact readback.
        // A cancellation or changed terms require another preparation.
        if (turn.role === "user" && (terms.research || !/^(?:(?:maybe|wait|not yet|hold on|yes|confirm)[.,!? ]*)?(?:(?:did you (?:buy|sell|place|submit) it(?: already)?|is (?:it|my order) (?:filled|done))\??)?[.!? ]*$/i.test(turn.message.trim()))) bound = false;
      }
    }
    return steps === 3;
  } catch { return false; }
}

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
    let disclosed = false;
    let requestedPurchase = false;
    const expected = terms.readback;
    for (const turn of entries) {
      for (const result of turn.role === "tool" || turn.role === "agent" ? turn.tool_results ?? [] : []) {
        if (!terms.toolNames.includes(result.tool_name)) {
          if (terms.research && result.tool_name !== "skip_turn") {
            bound = false; steps = 0; disclosed = false; requestedPurchase = false;
          }
          continue;
        }
        // An interrupted preparation returns a plain-text error. Only its own attempt is invalid.
        bound = false;
        disclosed = false;
        requestedPurchase = false;
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
      if (terms.research && bound) {
        const words = normalizeReadback(turn.message);
        if (!words) continue; // Provider silence markers carry no decision.
        if (turn.role === "agent") {
          // A provider may prepend its own recovery sentence to an otherwise exact offer.
          const offer = words.replace(/^i missed the confirmation(?: again| once more)? so no research was purchased /, "");
          const full = offer === normalizeReadback(expected);
          const short = /^(?:confirm|confirm the research purchase|should i buy the research|do you want me to buy the research)$/.test(words);
          steps = !turn.interrupted && (full || (disclosed && requestedPurchase && short)) ? 2 : 0;
          if (steps === 2 && full) disclosed = true;
          // An altered offer must disclose the stored terms again before a short yes can count.
          if (!full && !short && /\b(?:usdc|dollars?|cents?|buy|purchase|trade|order)\b/.test(words)) disclosed = false;
          requestedPurchase = false;
        } else if (turn.role === "user") {
          const purchase = /^(?:(?:yes|please|sure) )?(?:(?:go ahead and )?(?:buy|purchase) (?:it|the (?:research|data)))(?: please)?$/.test(words);
          const info = /^(?:that sounds interesting )?(?:tell me more(?: about it)?|what is it|what does (?:it|the research) (?:show|include)|what do i get)$/.test(words);
          const explainThenBuy = /^(?:(?:sure|please) )?(?:go ahead and )?(?:purchase|buy) the (?:data|research) and read it (?:out )?to me(?: so i can make (?:a )+decision(?: here)?)?$/.test(words);
          if (steps === 2 && (isSpokenConfirmation(turn.message) || purchase)) steps = 3;
          else steps = 0;
          requestedPurchase = disclosed && (purchase || explainThenBuy);
          if (!steps && !requestedPurchase && !info) { disclosed = false; bound = false; }
          // "Buy it" can itself approve, or the agent can follow it with a short confirmation.
        }
        continue;
      }
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

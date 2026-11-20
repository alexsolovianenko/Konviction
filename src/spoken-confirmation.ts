type Action = "buy" | "market-buy" | "sell" | "research" | "confirmation";

export function orderAction(side?: string, mode?: string): Action {
  if (side === "sell") return "sell";
  if (side === "buy") return mode === "market" ? "market-buy" : "buy";
  return "confirmation";
}

// Match the whole answer as a sequence of conversational phrases. Unconsumed
// words (a condition, a different action, a number, etc.) cannot authorize it.
const courtesy = /^(?:uh|um|erm?|ah|oh|well|okay|ok|please(?! do(?: |$))|thanks|thank you|sure)\b\s*/;
const assent = [
  /^(?:yes|yeah?|yep|yup|absolutely|definitely|affirmative|of course|for sure|correct)\b\s*/,
  /^(?:(?:i )?(?:confirm|approve)(?: (?:it|that))?|confirmed|i agree|i do|i(?:'d| would) (?:like|love) that)\b\s*/,
  /^(?:(?:that |it )?(?:sounds|looks) good(?: to me)?|(?:that |it )?works for me|(?:that would|that'd) be (?:great|fine)|(?:that's|thats|that is) (?:right|correct|fine(?: (?:with|by) me)?))\b\s*/,
  /^(?:(?:go (?:right )?ahead|proceed)(?: with (?:it|that))?|(?:let's |lets |let us )?do (?:it|that)|please do(?: (?:it|that))?|let's go ahead|go for it|go through with it|you have my (?:approval|permission)|make it happen)\b\s*/,
];
const leadIn = /^(?:go (?:right )?ahead and|i want you to|i(?:'d| would) like you to|you can|you have my approval to)(?: |$)/;
const actions: Partial<Record<Action, RegExp>> = {
  research: /^(?:buy|purchase|get) (?:it|the (?:research(?: data)?|data|report))\b\s*/,
  buy: /^(?:buy (?:it|them)|place (?:it|the order|my order))\b\s*/,
  "market-buy": /^(?:buy (?:now|it(?: now)?|them)|place (?:it|the order|my order))\b\s*/,
  sell: /^(?:sell (?:it|them)|place (?:it|the order|my order))\b\s*/,
};

const declines = [
  /^(?:sure|sure thing)(?: please| thanks| thank you)?$/,
  /^(?:no|nope|nah|not (?:now|today|this time|interested|for me)|maybe later|never ?mind)\b/,
  /^(?:skip|pass|stop|hold off|forget it|leave it|don'?t|do not|(?:i )?decline)\b/,
  /^i (?:don'?t|do not) (?:think so|want to|want it)\b/,
  /^i(?:'d| would) rather not\b|^i(?:'ll| will) (?:pass|decline|skip|sit this one out)\b/,
  /^i(?: am|'m) (?:good|all set)\b/,
];

export function spokenDecision(text: string, action: Action = "confirmation"): "yes" | "no" | "unclear" {
  let rest = text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[.,!]/g, " ").trim().replace(/\s+/g, " ");
  if (!rest || rest.includes("?")) return "unclear";
  const answer = rest.replace(/^(?:(?:uh|um|well|okay|please) )+/, "");
  if (declines.some(pattern => pattern.test(answer))) return "no";
  if (action === "research" && /^just (?:trade|buy (?:the (?:contract|prediction)|(?:yes|no) contracts))\b/.test(answer)) return "no";

  let approved = false;
  while (rest) {
    const polite = courtesy.exec(rest);
    if (polite) {
      rest = rest.slice(polite[0].length);
      continue;
    }
    // A lead-in like “go ahead and” needs a complete action after it.
    rest = rest.replace(leadIn, "");
    const match = actions[action]?.exec(rest) ?? assent.map(pattern => pattern.exec(rest)).find(Boolean);
    if (!match) return "unclear";
    approved = true;
    rest = rest.slice(match[0].length);
  }
  return approved ? "yes" : "unclear";
}

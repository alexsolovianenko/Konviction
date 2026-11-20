import { describe, expect, it } from "vitest";
import { spokenDecision } from "./spoken-confirmation";

describe("spoken decisions about the current action", () => {
  it.each(["Yes, please.", "Please do.", "That would be great.", "Yeah, go ahead!", "That sounds good to me.", "Please do that.",
    "Um, yep. Thank you.", "Go right ahead and do it", "I’d like that", "I approve", "Yes, that is correct."])(
    "accepts %s", text => expect(spokenDecision(text)).toBe("yes"));
  it.each(["sure", "Sure, thanks.", "I don’t think so", "no thanks", "I’d rather not", "I'll pass"])(
    "declines %s", text => expect(spokenDecision(text)).toBe("no"));
  it.each(["yes but make it ten", "yes if the price drops", "yes contracts", "yes?", "go ahead and",
    "yes actually no", "maybe", "thank you", "what do you think?", ""])(
    "withholds approval for %s", text => expect(spokenDecision(text)).toBe("unclear"));
  it("matches action words only to the proposal being read", () => {
    expect(spokenDecision("Yes, please sell it.", "sell")).toBe("yes");
    expect(spokenDecision("Yes, please sell it.", "buy")).toBe("unclear");
    expect(spokenDecision("Please purchase the data", "research")).toBe("yes");
    expect(spokenDecision("Please purchase the data", "buy")).toBe("unclear");
    expect(spokenDecision("Buy now", "buy")).toBe("unclear");
    expect(spokenDecision("Buy now", "market-buy")).toBe("yes");
  });
});

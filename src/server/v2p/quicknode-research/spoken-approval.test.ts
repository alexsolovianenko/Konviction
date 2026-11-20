import {expect,it} from "vitest";
import {approvedResearch} from "./spoken-approval";

const offer = "Would you like to buy Bitcoin research from QuickNode for 0.0001 testnet USDC?";
const bound = {role:"tool",tool_results:[{tool_name:"request_research_quote",result_value:JSON.stringify({ok:true,quote_id:"q"})}]};
const ask = {role:"agent",message:offer};
const yes = {role:"user",message:"Yes."};
const approved = (...entries: unknown[]) => approvedResearch(JSON.stringify({entries}),"q",offer);
it("requires the matching quote, exact price, uninterrupted offer and immediate explicit assent", () => {
  expect(approved(bound,ask,yes)).toBe(true);
  expect(approved(ask,yes)).toBe(false);
  expect(approved(bound,{...ask,interrupted:true},yes)).toBe(false);
  expect(approved(bound,{...ask,message:offer.replace("0.0001","0.01")},yes)).toBe(false);
  expect(approved(bound,ask,{...yes,message:"No"})).toBe(false);
  expect(approved(bound,ask,{...yes,message:"Buy ten dollars of YES"},yes)).toBe(false);
  expect(approved(bound,ask,yes,{...yes,message:"Wait"})).toBe(false);
});

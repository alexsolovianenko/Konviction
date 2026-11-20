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
it("accepts buy it and a short reconfirmation for only the already disclosed research", () => {
  const buy = {role:"user",message:"Buy it."};
  const confirm = {role:"agent",message:"Confirm?"};
  expect(approved(bound,ask,buy)).toBe(true);
  expect(approved(bound,ask,buy,confirm,yes)).toBe(true);
  expect(approved(bound,ask,{role:"user",message:"Tell me more about it."},{role:"agent",message:"It measures network activity."},buy,confirm,yes)).toBe(true);
  expect(approved(bound,ask,{role:"user",message:"Buy $5 of XRP"},confirm,yes)).toBe(false);
  expect(approved(bound,buy,confirm,yes)).toBe(false);
  expect(approved(bound,ask,buy,{role:"agent",message:"Buy it for 5 USDC?"},yes)).toBe(false);
  expect(approved(bound,{role:"agent",message:"I missed the confirmation, so no research was purchased. "+offer},yes)).toBe(true);
});

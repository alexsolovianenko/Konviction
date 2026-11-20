// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./gemini", async original => ({ ...await original<typeof import("./gemini")>(), getEvent: vi.fn(), gPrivate: vi.fn() }));
import { getEvent, gPrivate } from "./gemini";
import { prepareTrade, executeTrade } from "./trade-engine";
const request = {event_ticker:"E", instrument_symbol:"S", side:"buy", outcome:"yes", order_mode:"market", budget_usd:2};
const hooks = {finish: vi.fn(), log:vi.fn(), receipt:vi.fn(), saveOrder:vi.fn()};
function quote(price: number) {
  return {event:{ticker:"E",title:"Example",contracts:[{instrumentSymbol:"S", status:"active", marketState:"open", label:"Up", prices:{buy:{yes:String(price)}}}]}};
}
function fill(id:string, filled:number, price:number, status:string) {
  return {ok:true,status:200,text:"",data:{orderId:id,filledQuantity:filled,avgExecutionPrice:price,status}};
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getEvent).mockResolvedValue(quote(.2));
});
it("sizes within the USD budget including fees and sends one IOC at the approved ceiling", async () => {
  const proposal = await prepareTrade(request, async (terms: Record<string, unknown>) => terms);
  expect(proposal).toMatchObject({quantity:9, limit_price:.20, budget_usd:2});
  expect(proposal.notional_usd + proposal.est_fee_usd).toBeLessThanOrEqual(2);
  vi.mocked(getEvent).mockResolvedValue(quote(.26));
  vi.mocked(gPrivate).mockResolvedValueOnce(fill("A",2,.19,"cancelled"));
  const result = await (await executeTrade(proposal,"test",hooks)).json();
  expect(gPrivate).toHaveBeenCalledTimes(1);
  expect(vi.mocked(gPrivate).mock.calls[0]?.[1]).toMatchObject({price:"0.20",quantity:"9",timeInForce:"immediate-or-cancel"});
  expect(result).toMatchObject({outcome_summary:"PARTIAL",filled_quantity:2,remaining_quantity:7,order_ids:["A"],voice_say:"$0.38 of $2.00 filled before fees. The rest was cancelled."});
  expect(hooks.saveOrder).toHaveBeenCalledOnce();
});
it("reports an unresolved response without submitting again", async () => {
  const proposal = await prepareTrade(request, async (terms: Record<string, unknown>) => terms);
  vi.mocked(gPrivate).mockResolvedValueOnce({ok:false,status:503,data:null,text:""});
  const result = await (await executeTrade(proposal,"test",hooks)).json();
  expect(result).toMatchObject({outcome_summary:"PENDING_UNKNOWN",filled_quantity:null,voice_say:"Final fill unconfirmed."});
  expect(gPrivate).toHaveBeenCalledTimes(1);
});
it("keeps the quoted ask even when a higher ceiling was suggested, and stops on zero fill", async () => {
  const proposal = await prepareTrade({...request,limit_price:.25}, async (terms: Record<string, unknown>) => terms);
  expect(proposal.limit_price).toBe(.20);
  vi.mocked(gPrivate).mockResolvedValueOnce(fill("A",0,0,"cancelled"));
  const result = await (await executeTrade(proposal,"test",hooks)).json();
  expect(result).toMatchObject({outcome_summary:"NOT_FILLED",voice_say:"Nothing filled at your price.",order_ids:["A"]});
  expect(gPrivate).toHaveBeenCalledTimes(1);
});
it("sells at the best bid, retries only remaining held contracts, and reports combined proceeds", async () => {
  const bid = (price:number) => ({event:{ticker:"E",contracts:[{instrumentSymbol:"S",status:"active",marketState:"open",prices:{sell:{yes:String(price)}}}]}});
  vi.mocked(getEvent).mockResolvedValueOnce(bid(.54)).mockResolvedValueOnce(bid(.52));
  vi.mocked(gPrivate).mockResolvedValueOnce({ok:true,status:200,text:"",data:{positions:[{symbol:"S",outcome:"yes",totalQuantity:6,quantityOnHold:2}]}})
    .mockResolvedValueOnce(fill("A",1,.54,"cancelled")).mockResolvedValueOnce(fill("B",3,.52,"filled"));
  const proposal={side:"sell",order_mode:"market",quantity:4,limit_price:.01,event_ticker:"E",instrument_symbol:"S",outcome:"yes",time_in_force:"immediate-or-cancel"};
  const result=await(await executeTrade(proposal,"test",hooks)).json();
  expect(result).toMatchObject({outcome_summary:"FILLED",filled_quantity:4,gross_proceeds_usd:2.10,filled_notional_usd:0,voice_say:"Filled 4 at 52.5 cents."});
  expect(vi.mocked(gPrivate).mock.calls.slice(1).map(([,b])=>[b?.["side"],b?.["quantity"],b?.["price"]])).toEqual([["sell","4","0.54"],["sell","3","0.52"]]);
});
it("closes an exact fractional holding when Gemini omits the increment", async () => {
  vi.mocked(getEvent).mockResolvedValue({event:{ticker:"E",contracts:[{instrumentSymbol:"S",status:"active",marketState:"open",prices:{sell:{yes:".50"}}}]}});
  vi.mocked(gPrivate).mockResolvedValueOnce({ok:true,status:200,text:"",data:{positions:[{symbol:"S",outcome:"yes",totalQuantity:0.65,quantityOnHold:0}]}})
    .mockResolvedValueOnce(fill("A",.65,.50,"filled"));
  const proposal={side:"sell",order_mode:"market",quantity:.65,limit_price:.01,event_ticker:"E",instrument_symbol:"S",outcome:"yes",time_in_force:"immediate-or-cancel"};
  const result=await(await executeTrade(proposal,"test",hooks)).json();
  expect(result).toMatchObject({outcome_summary:"FILLED",filled_quantity:.65});
  expect(vi.mocked(gPrivate).mock.calls[1]?.[1]?.["quantity"]).toBe("0.65");
});

it("reports an explicit Gemini rejection even on a successful HTTP response", async () => {
  const proposal = await prepareTrade(request, async (terms: Record<string, unknown>) => terms);
  vi.mocked(gPrivate).mockResolvedValueOnce(fill("A",0,0,"rejected"));
  const result = await (await executeTrade(proposal,"test",hooks)).json();
  expect(result).toMatchObject({ok:false,outcome_summary:"EXCHANGE_REJECTED",filled_quantity:0});
  expect(gPrivate).toHaveBeenCalledTimes(1);
});

// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { prepareTrade } from "./trade-engine";
import { getEvent, gPrivate } from "./gemini";

vi.mock("./gemini", async original => ({
  ...(await original<typeof import("./gemini")>()), getEvent: vi.fn(), gPrivate: vi.fn(),
}));
const exit = {event_ticker: "EVENT", instrument_symbol: "CONTRACT", outcome: "yes", side: "sell"};
function market(bid: string | null) {
  vi.mocked(getEvent).mockResolvedValue({ event: {ticker:"EVENT", contracts:[
    { instrumentSymbol:"CONTRACT", label:"Up", status:"active", marketState:"open", quantityIncrement:"0.01",
      quantityMinimum:"0.05", prices:{sell:bid === null ? {} : {yes:bid}} },
  ]} });
}
beforeEach(() => {
  market(".30");
  vi.mocked(gPrivate).mockResolvedValue({ok:true,status:200,text:"",data:{positions:[
    {symbol:"OTHER", outcome:"yes", totalQuantity:"900", quantityOnHold:"0"},
    {symbol:"CONTRACT", outcome:"no", totalQuantity:"30", quantityOnHold:"0"},
    {symbol:"CONTRACT", outcome:"yes", totalQuantity:"203.38", quantityOnHold:"1.25"},
  ]}});
});
const prepare = (params: Record<string, unknown>) => prepareTrade({...exit,...params}, async (terms: unknown) => terms);
it("prepares closing the entire available fractional position at market and estimates proceeds from the actual bid", async () => {
  expect(await prepare({order_mode:"market",close_all:true})).toMatchObject({
    quantity:202.13,quote_price:.30,limit_price:.01,notional_usd:60.64,time_in_force:"immediate-or-cancel",
  });
});
it("can rest a limit exit without a bid but requires a real bid to estimate a market exit", async () => {
  market(null);
  expect(await prepare({quantity:.12,limit_price:.45})).toMatchObject({
    quantity:.12,limit_price:.45,quote_price:null,time_in_force:"good-til-cancel",
  });
  expect(await (await prepare({order_mode:"market",quantity:.12})).json()).toMatchObject({error:"NO_BID"});
});
it("refuses unavailable, below-minimum, or off-grid quantities rather than silently rounding them", async () => {
  for(const [quantity,error] of [[210,"INSUFFICIENT_POSITION"],[.01,"BELOW_CONTRACT_MINIMUM"],[1.001,"INVALID_QUANTITY"]]) {
    expect(await (await prepare({quantity,limit_price:.45})).json()).toMatchObject({error});
  }
});

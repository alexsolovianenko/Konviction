import { beforeEach, expect, it, vi } from "vitest";
import { buildSandboxCombo } from "./build-combo";
import { getEvent, gPrivate, gPublic } from "./gemini";

vi.mock("./gemini", async importOriginal => ({
  ...await importOriginal<typeof import("./gemini")>(), getEvent: vi.fn(), gPrivate: vi.fn(), gPublic: vi.fn(),
}));

const expiry = "2099-12-31T22:00:00Z";
const legs = [
  { event_ticker: "GOLD", contract_symbol: "GEMI-GOLD-HI3800", outcome: "yes" },
  { event_ticker: "ETH", contract_symbol: "GEMI-ETH-HI2000", outcome: "no" },
];
const registered = [
  { contractId: "42", requiredOutcome: "Yes" }, { contractId: "51", requiredOutcome: "No" },
];
const symbol = "GEMI-CMB-NOV-CMB", ticker = "CMB-NOV";
const response = (data: unknown) => ({ ok: true, status: 200, text: "", data });
const definition = { instrumentRegistered: true, instrumentSymbol: symbol, legs: [...registered].reverse() };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getEvent).mockImplementation(async t => {
    const index = legs.findIndex(l => l.event_ticker === t);
    const joint = t === ticker;
    if (!joint && index === -1) return { event: null };
    return { event: { ticker: t, id: "71", status: "active", title: t + " November prediction",
      contracts: [{ id: joint ? "71-89" : "71-" + registered[index]!.contractId,
        label: "Threshold", instrumentSymbol: joint ? symbol : legs[index]!.contract_symbol,
        status: "active", marketState: "open", expiryDate: expiry, isCombo: joint,
        prices: { buy: { yes: joint ? ".23" : ".44" } } }] } };
  });
  vi.mocked(gPrivate).mockResolvedValue(response({ combo: definition }));
  vi.mocked(gPublic).mockResolvedValue(response({
    contract: { instrumentSymbol: symbol, eventTicker: ticker, contractStatus: "Active", expiryDate: expiry },
    legs: legs.map((l, i) => ({ ...registered[i], contract: { instrumentSymbol: l.contract_symbol,
      eventTicker: l.event_ticker, contractStatus: "Active", expiryDate: expiry } })),
  }));
});

it("registers exactly the resolved leg IDs and outcomes, and reads the joint ask", async () => {
  const result = await buildSandboxCombo({ legs });
  expect(result).toMatchObject({ok:true, quoted:true, buy_price:.23, implied_percent:23, payout_per_winning_contract_usd:1,
    contract_symbol:symbol, event_ticker:ticker});
  expect(gPrivate).toHaveBeenCalledExactlyOnceWith("/v1/prediction-markets/combos", { legs: registered }, { jsonBody: true });
  expect(gPublic).toHaveBeenCalledWith("/v1/prediction-markets/combos/" + symbol);
});

it("rejects duplicate and unresolved legs before registration", async () => {
  for (const invalid of [[legs[0],legs[0]], [legs[0]], [legs[0],{...legs[1],event_ticker:"OTHER"}]]) {
    expect(await buildSandboxCombo({legs:invalid})).toMatchObject({ok:false});
  }
  expect(gPrivate).not.toHaveBeenCalled();
});

it("rejects an exchange result that changes one leg, and an unregistered combination", async () => {
  vi.mocked(gPrivate).mockResolvedValueOnce(response({ combo:{...definition,legs:[registered[0],{ ...registered[1], requiredOutcome:"Yes" }]}}));
  expect(await buildSandboxCombo({legs})).toMatchObject({ok:false,error:"COMBO_MISMATCH"});
  vi.mocked(gPrivate).mockResolvedValueOnce(response({combo:{...definition,instrumentRegistered:false}}));
  expect(await buildSandboxCombo({legs})).toMatchObject({ok:false,error:"COMBO_UNREGISTERED"});
  expect(gPublic).not.toHaveBeenCalled();
});

it("reports an absent joint ask without constructing one from the legs", async () => {
  const get = vi.mocked(getEvent).getMockImplementation()!;
  vi.mocked(getEvent).mockImplementation(async t => {
    const result = await get(t);
    if (t === ticker) result.event!.contracts![0]!.prices = { buy: {} };
    return result;
  });
  expect(await buildSandboxCombo({legs})).toMatchObject({ok:true, quoted:false, buy_price:null, implied_percent:null});
  expect(gPrivate).toHaveBeenCalledTimes(1);
});

it("uses an exact already-listed combination when registration is unavailable to the account", async () => {
  vi.mocked(gPrivate).mockResolvedValueOnce({ok:false, status:403, data:null, text:""});
  const detail = (await vi.mocked(gPublic).getMockImplementation()!("")).data;
  vi.mocked(gPublic).mockResolvedValueOnce(response({combos:[
    {contract:{instrumentSymbol:"WRONG"},legs:detail.legs.slice(0,1)}, detail,
  ],pagination:{total:2}}));
  const result = await buildSandboxCombo({legs});
  expect(result).toMatchObject({ok:true, quoted:true, contract_symbol:symbol});
});

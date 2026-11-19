import { afterEach, expect, it, vi } from 'vitest';
import { marketTool } from './market-tools';
afterEach(() => vi.unstubAllGlobals());

it('refreshes even an identical search and surfaces an unavailable upstream', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({data: []})).mockResolvedValueOnce(new Response('', {status:503}));
  vi.stubGlobal('fetch', fetchMock);
  const params = new URLSearchParams({query:''});
  expect(await (await marketTool('search_markets',params)).json()).toMatchObject({ok:true, events:[]});
  expect((await marketTool('search_markets',params)).status).toBe(502);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url.origin).toBe('https://api.sandbox.gemini.com');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({Accept:'application/json'});
  }
});

it('rejects unknown identifiers and only quotes the selected event and symbol', async () => {
  const get = vi.fn(async () => Response.json({data:{ticker:'E', title:'Test', contracts:[{instrumentSymbol:'C', prices:{buy:{yes:'0.43'}}}]}}));
  vi.stubGlobal('fetch',get);
  const quote = (symbol: string) => marketTool('get_orderbook',new URLSearchParams({event_ticker:'E',contract_symbol:symbol}));
  expect((await quote('../')).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
  expect((await quote('OTHER')).status).toBe(404);
  expect(await (await quote('C')).json()).toMatchObject({contract:{symbol:'C', buy:{yes:.43,no:null}}});
});

it('checks each requested five-minute series directly and keeps post-only windows out of purchase selection', async () => {
  const now = Date.parse('2026-11-19T10:04:31Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const mock = vi.fn(async (url: URL) => {
    const series = url.searchParams.get('search')!;
    const window = (index: number, seconds: number, state: string) => ({
      ticker: series + "261119100" + index, title: series + ' window ' + index,
      contracts: [{ instrumentSymbol: series + index + '-UP', label:'Up', status:'active',
        marketState:state, expiryDate:new Date(now + seconds * 1000).toISOString() }],
    });
    return Response.json({data:[window(3,329,series === 'BTC05M' ? 'post_only' : 'open'),window(1,-5,'open'),window(2,29,'open')]});
  });
  vi.stubGlobal('fetch',mock);
  try {
    const reply = await (await marketTool('search_markets',new URLSearchParams({query:'track Bitcoin up and Ethereum down five-minute'}))).json();
    expect(reply.track_group).toBe(true);
    expect(reply.timing.map((w: {tracked_outcome:string}) => w.tracked_outcome)).toEqual(['yes','no']);
    expect(reply.events.map((e: {ticker:string}) => e.ticker)).toEqual(['BTC05M2611191002','ETH05M2611191003']);
    expect(reply.timing[0]).toMatchObject({imminent:true,current:{seconds_to_expiry:29},next_window:{seconds_to_expiry:329,market_state:'post_only'}});
    expect(mock).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); }
});

it('returns separate before-fee settlement amounts from each observed buy quote', async () => {
  vi.stubGlobal('fetch',vi.fn(async () => Response.json({data:{ticker:'E',title:'Event',
    contracts:[{instrumentSymbol:'C',prices:{buy:{yes:'0.43'}}}]}})));
  const result = await (await marketTool('get_orderbook',new URLSearchParams({event_ticker:'E',contract_symbol:'C'}))).json();
  expect(result.payout_per_contract).toEqual({yes:{cost_usd:.43,winning_settlement_usd:1,losing_settlement_usd:0,
    winning_profit_before_fees_usd:.57,maximum_loss_before_fees_usd:.43},no:null});
});

it('discovers native Gemini combos with required directions and leg results', async () => {
  const get = vi.fn(async () => Response.json({combos:[{contract:{instrumentSymbol:'COMBO',eventTicker:'CMB',contractName:'Two outcomes'},
    legs:[{requiredOutcome:'Yes',contract:{contractName:'Up',eventName:'Bitcoin price today'}},
      {requiredOutcome:'No',legOutcome:'Fail',contract:{contractName:'Up',eventName:'Ethereum price today'}}]}]}));
  vi.stubGlobal('fetch',get);
  const result = await (await marketTool('search_markets',new URLSearchParams({query:'BTC and ETH combos'}))).json();
  expect(result).toMatchObject({listing_only:true,matched_in_page:1,combos:[{symbol:'COMBO',legs:[{outcome:'Yes'},{outcome:'No',resolution:'Fail'}]}]});
  expect(get).toHaveBeenCalledWith(expect.objectContaining({pathname:'/v1/prediction-markets/combos'}),expect.objectContaining({method:'GET'}));
  expect(result.combos[0]).not.toHaveProperty('price');
});

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
    expect(reply.events.map((e: {ticker:string}) => e.ticker)).toEqual(['BTC05M2611191002','ETH05M2611191002']);
    expect(reply.timing[0]).toMatchObject({imminent:false,current:{seconds_to_expiry:29,buy_window_open:true},next_window:{seconds_to_expiry:329,market_state:'post_only'}});
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

it.each([
  { asks: [{ price: '0.43', amount: '1.5' }], bids: [{ price: '0.21', amount: '5.0' }], expected: { yes: 1.5, no: 5 } },
  { asks: [{ price: '0.44', amount: '8' }], bids: [], expected: { yes: null, no: null } },
  { asks: [], bids: [{ price: '0.21', amount: 'invalid' }], expected: { yes: null, no: null } },
  { asks: null, bids: null, expected: { yes: null, no: null } },
])('reports only displayed size matching the quoted prices', async ({asks,bids,expected}) => {
  const get = vi.fn(async (url: URL) => {
    if (url.pathname === '/v1/book/C') {
      expect(url.searchParams.get('limit_asks')).toBe('1');
      expect(url.searchParams.get('limit_bids')).toBe('1');
      return asks ? Response.json({asks,bids}) : new Response('', {status:503});
    }
    return Response.json({ticker:'E',title:'Event',contracts:[{instrumentSymbol:'C',prices:{buy:{yes:'.43',no:'.79'}}}]});
  });
  vi.stubGlobal('fetch',get);
  const result = await (await marketTool('get_orderbook',new URLSearchParams({event_ticker:'E',contract_symbol:'C'}))).json();
  expect(result).toMatchObject({ok:true, contract:{buy:{yes:.43,no:.79}}, displayed_buy_quantity_at_ask:expected});
});

it('ranks event-wide volume across pages and filters individual contract deadlines', async () => {
  const now = Date.now();
  const event = (ticker: string, volume: string | null, minutes: number) => ({
    ticker, title: "Bitcoin " + ticker, volume, contracts: [{ instrumentSymbol: ticker + "-UP",
      expiryDate: new Date(now + minutes * 60_000).toISOString() }],
  });
  const pages = [
    [event('BTC-A', '1200', 100), event('BTC-B', '1001', 4), event('BTC-C', null, 3)],
    [event('BTC-D', '2100', 9), event('BTC-E', '9999', -1), event('BTC-F', '42', 3)],
  ];
  vi.stubGlobal('fetch', async (url: URL) => Response.json({
    data: pages[url.searchParams.get('offset') === '0' ? 0 : 1], pagination: { total: 6 },
  }));
  const query = 'Bitcoin highest volume minimum volume $1k ending within 15 minutes';
  const reply = await (await marketTool('search_markets', new URLSearchParams({query}))).json();
  expect(reply.events.map((e: {ticker: string; volume_usd: number}) => [e.ticker, e.volume_usd]))
    .toEqual([['BTC-D', 2100], ['BTC-B', 1001]]);
});

it.each([
  {outcome:'yes',side:'buy',limit:'0.54',displayed:6,avg:.515, spread:.1},
  {outcome:'no',side:'buy',limit:'0.6',displayed:2,avg:.6, spread:.1},
  {outcome:'yes',side:'sell',limit:'0.39',displayed:2,avg:.4, spread:.1},
  {outcome:'no',side:'sell',limit:'0.46',displayed:6,avg:.485, spread:.1},
  {outcome:'yes',side:'buy',limit:'0.48',displayed:0,avg:null, spread:.1},
])('walks the sandbox $outcome $side book best-first through $limit', async ({outcome,side,limit,displayed,avg,spread}) => {
  const fetchBook = vi.fn(async (url: URL, init: RequestInit) => {
    expect(init.method).toBe('GET');
    if (url.pathname === '/v1/book/C') {
      expect(url.searchParams.toString()).toBe('limit_bids=0&limit_asks=0');
      return Response.json({ asks:[{price:'.53',amount:'4'},{price:'.50',amount:'2'}],
        bids:[{price:'.38',amount:'4'},{price:'.40',amount:'2'}] });
    }
    return Response.json({ticker:'E', title:'Event', contracts:[{instrumentSymbol:'C'}]});
  });
  vi.stubGlobal('fetch',fetchBook);
  const params = new URLSearchParams({event_ticker:'E',contract_symbol:'C',outcome,side,quantity:'4',limit_price:limit});
  const result = await (await marketTool('get_orderbook',params)).json();
  expect(result.liquidity).toMatchObject({side,outcome,snapshot_only:true,depth_unknown:false,spread,
    displayed_quantity:displayed,estimated_executable_quantity:Math.min(4, displayed),estimated_average_price:avg});
});

it.each([
  {book:{asks:[],bids:[]}, depth:0, unknown:false},
  {book:{asks:null,bids:[]}, depth:null, unknown:true},
  {book:{asks:[{price:'.5',amount:false}],bids:[]}, depth:null, unknown:true},
  {book:{asks:[{price:'.5',amount:'3'}],bids:[{price:'.6',amount:'3'}]}, depth:null, unknown:true},
  {book:null, depth:null, unknown:true},
])('distinguishes absent, unreliable and empty depth', async ({book,depth,unknown}) => {
  vi.stubGlobal('fetch',async (url: URL) => url.pathname === '/v1/book/C'
    ? book ? Response.json(book) : new Response('',{status:503})
    : Response.json({ticker:'E',title:'Event',contracts:[{instrumentSymbol:'C'}]}));
  const params = new URLSearchParams({event_ticker:'E',contract_symbol:'C',outcome:'yes',limit_price:'.5'});
  const result = await (await marketTool('get_orderbook',params)).json();
  expect(result.liquidity).toMatchObject({side:'buy',depth_unknown:unknown,displayed_quantity:depth,spread:null,
    estimated_executable_quantity:null,estimated_average_price:null});
});

it.each(['quantity=2','outcome=yes&quantity=1.5','outcome=no&limit_price=0','outcome=yes&side=hold',
  'outcome=yes&outcome=no','outcome=yes&extra=1'])('rejects invalid liquidity input %s before fetching', async extra => {
  const get = vi.fn();
  vi.stubGlobal('fetch',get);
  const params = new URLSearchParams('event_ticker=E&contract_symbol=C&' + extra);
  expect((await marketTool('get_orderbook', params)).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
});

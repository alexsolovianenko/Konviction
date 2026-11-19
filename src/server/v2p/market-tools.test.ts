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

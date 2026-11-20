import {expect, it, vi} from 'vitest';
import {Voice} from './voice';
import {tradingRequest} from './browserTrading';

const {start, trade} = vi.hoisted(() => ({start:vi.fn(), trade:vi.fn()}));
vi.mock('@elevenlabs/client', () => ({Conversation:{startSession:start}}));
vi.mock('./browserTrading', () => ({workerTrading:true, tradingRequest:trade}));

it.each([false, true])('keeps voice settings and confirmations scoped to Mommy mode = %s', async (mommyMode) => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[]})}});
  const update = vi.fn();
  const voice = new Voice(update, vi.fn());
  const readback = 'Buy one yes contract. Say confirm.';
  const credentials = {signed_url:'wss://mock.test/?conversation_id=conv_1', session_token:'test-session', session_id:'1'};
  trade.mockImplementation(async (path:string) => {
    if(path === 'session') return {ok:true,...credentials};
    if(path === 'proposals') return {ok:true, availability:{execution_enabled:true,call_confirmation_supported:true,voice_authorized:false},
      proposal:{proposal_id:'proposal-1',voice_readback:readback,expires_at:new Date(Date.now()+60_000).toISOString()}};
    if(path === 'portfolio') return {ok:true,as_of:new Date().toISOString(),positions:{rows:[{symbol:'GEMI-C',outcome:'yes',totalQuantity:'2',unrealizedPnl:'.12'}]},
      history:{rows:[{symbol:'GEMI-C',status:'filled',filledQuantity:'2',remainingQuantity:'0',avgExecutionPrice:'.42',orderId:'private-id'}]},orders:{rows:[]},settlements:{rows:[]}};
    if(path === 'order-result') return {ok:true,outcome_summary:'FILLED',order_id:'order-1',say:'One contract filled.'};
    return {ok:true};
  });
  const context = vi.fn();
  start.mockResolvedValue({endSession:vi.fn(),sendContextualUpdate:context});
  try {
    await voice.start(mommyMode);
    const opts = start.mock.calls[0]![0];
    expect(opts.overrides).toEqual(mommyMode ? {tts:{voiceId:'tQ4MEZFJOzsahSEEZtHK',speed:0.9}} : undefined);
    expect(context.mock.calls.some(([message]) => message.includes('Mommy mode is enabled'))).toBe(mommyMode);
    expect(opts.dynamicVariables.secret__trade_session_token).toBe(credentials.session_token);
    const order = {event_ticker:'EVENT', contract_symbol:'GEMI-C',quantity:1,limit_price:.4};
    const prepare = async () => JSON.parse(await opts.clientTools.prepare_sandbox_buy(order));
    expect(await prepare()).toMatchObject({next_action:'select_market'});
    const fetchMock = vi.spyOn(globalThis,'fetch').mockImplementation(async () => Response.json({
      ok:true, status:'quoted',quote_id:'research-q',payments_enabled:true,price_usdc:'0.0001',
      expires_at:new Date(Date.now()+60000).toISOString(),say:'Buy QuickNode research?',context:{
        market:{event_ticker:'EVENT',contract_symbol:'GEMI-C'},asset:{name:'Bitcoin',symbol:'BTC'}
      }
    }));
    voice.setVisibleContract('EVENT','GEMI-C');
    expect(await prepare()).toMatchObject({next_action:'request_research_quote'});
    await opts.clientTools.request_research_quote();
    expect(await prepare()).toMatchObject({next_action:'wait_for_research_decision'});
    opts.onMessage({role:'agent',message:'Buy QuickNode research?',event_id:1});
    opts.onMessage({role:'user',message:'No thanks.'});
    expect(trade.mock.calls.map(([path])=>path)).not.toContain('proposals');
    const reply = await prepare();
    fetchMock.mockRestore();
    expect(reply).toMatchObject({proposal_id:'proposal-1', confirmation_tool:'confirm_hosted_sandbox_buy',say:readback});
    expect(JSON.stringify(reply)).not.toContain(credentials.session_token);
    await vi.advanceTimersByTimeAsync(2100);
    expect(tradingRequest).toHaveBeenCalledWith('order-result',{proposal_id:'proposal-1'},credentials.session_token);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({proposal:null,tradeMessage:expect.stringContaining('One contract filled.')}));
    voice.setVisibleContract('EVENT', 'GEMI-C');
    const position = JSON.parse(await opts.clientTools.get_sandbox_positions({}));
    expect(position.positions).toEqual([expect.objectContaining({on_screen:true,quantity:2,unrealized_pnl_usd:.12})]);
    expect(position.recent_orders).toEqual([expect.objectContaining({on_screen:true,status:'filled',filled_quantity:2,remaining_quantity:0})]);
    expect(JSON.stringify(position)).not.toMatch(/GEMI-C|private-id/);
    expect(trade.mock.calls.map(([path])=>path)).toEqual(['session','proposals','order-result','portfolio']);
  } finally {
    await voice.stop();
    if(original) Object.defineProperty(navigator,'mediaDevices',original);
    else Reflect.deleteProperty(navigator,'mediaDevices');
    vi.useRealTimers();
  }
});

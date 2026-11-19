import { act, fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Callbacks } from '@elevenlabs/client';
import { Dashboard } from './Dashboard';

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: start } }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let issued = 0;
  let lastSeq = 0;
  const requests: { path: string; body: Record<string, any>; headers: Record<string, string> }[] =
    [];
  const stopTrack = vi.fn(),
    endSession = vi.fn().mockResolvedValue(undefined);
  const mic = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: mic },
  });
  const fetchMock = vi.fn(async (path: string, opts: RequestInit) => {
    const body = opts.body ? JSON.parse(String(opts.body)) : {};
    requests.push({ path, body, headers: opts.headers as Record<string, string> });
    if (path.endsWith('/signed-url')) {
      lastSeq = 0;
      return Response.json({
        session_id: 'session-' + ++issued,
        session_token: 'private-' + issued,
        signed_url: 'wss://mock.test/' + issued,
      });
    }
    if (path.endsWith('/transcripts')) {
      lastSeq = body['entries'].at(-1)?.seq ?? lastSeq;
      return Response.json({ last_seq: lastSeq });
    }
    if (path.startsWith('/api/intents?'))
      return Response.json({
        intents: [
          {
            id: 'audit',
            intent: 'market_query',
            venue: 'gemini_spot',
            created_at: '2026-11-19T00:00:00Z',
            instrument: 'bitcoin',
            side: null,
            quantity: null,
            order_id: null,
            utterance: 'bitcoin',
          },
        ],
      });
    return Response.json({ ok: true, simulated: true, count: 1 });
  });
  vi.stubGlobal('fetch', fetchMock);
  start.mockReset().mockImplementation(async (opts: Callbacks) => {
    opts.onConnect?.({ conversationId: 'conv-' + issued });
    return { endSession };
  });
  render(<Dashboard />);
  const begin = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start Voice' }));
    await screen.findByText('Microphone · Listening');
    return start.mock.calls.at(-1)![0] as Callbacks & {
      clientTools: Record<string, (args: object) => Promise<string>>;
    };
  };
  const finals = () => requests.filter((r) => r.body['final']);
  const entries = () =>
    requests.filter((r) => r.path.endsWith('/transcripts')).flatMap((r) => r.body['entries']);
  return { mic, stopTrack, endSession, requests, begin, finals, entries, fetchMock };
}
it('explains microphone denial before signing and allows another attempt', async () => {
  const f = fixture();
  f.mic.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
  fireEvent.click(screen.getByText('Start Voice'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Microphone blocked');
  expect(f.requests.filter(r => r.path !== "/api/trading/availability")).toHaveLength(0);
  await f.begin();
  expect(f.stopTrack).toHaveBeenCalledOnce();
});
it('flushes before a tool, returns its JSON, persists tool evidence and shows captured intents', async () => {
  const f = fixture(),
    opts = await f.begin();
  expect(start.mock.calls[0]![0]).toMatchObject({
    signedUrl: 'wss://mock.test/1',
    connectionType: 'websocket',
  });
  act(() => opts.onMessage?.({ role: 'user', source: 'user', event_id: 1, message: 'bitcoin' }));
  let result = '';
  await act(async () => {
    result = await opts.clientTools['get_order_status']!({
      venue: 'gemini_spot',
      query: 'btc',
      utterance: 'bitcoin',
    });
  });
  expect(JSON.parse(result)).toEqual({ ok: true, simulated: true, count: 1 });
  const at = f.requests.findIndex((r) => r.path.endsWith('/get_order_status'));
  expect(f.requests.slice(0, at).some((r) => r.body['entries']?.[0]?.text === 'bitcoin')).toBe(true);
  expect(f.requests[at]!.body).toMatchObject({
    last_transcript_seq: 1,
    session_id: 'session-1',
    parameters: { order_id: null },
  });
  expect(f.requests[at]!.headers['Authorization']).toBe('Bearer private-1');
  expect(f.entries().map((e) => e.role)).toEqual(['user', 'tool']);
  expect(screen.getByText('market query')).toBeInTheDocument();
});
it('ends during speech, records only played text and ignores late callbacks', async () => {
  const f = fixture(),
    opts = await f.begin();
  act(() => {
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onMessage?.({
      source: 'ai',
      role: 'agent',
      event_id: 2,
      message: 'Confirming. Say yes to confirm.',
    });
    opts.onAudioAlignmentPlayback?.({
      event_id: 2,
      alignment: {
        chars: ['C', 'o', 'n'],
        char_start_times_ms: [0, 0, 10000],
        char_durations_ms: [0, 0, 10],
      },
    });
  });
  fireEvent.click(screen.getByText('End Session'));
  await waitFor(() => expect(f.finals()).toHaveLength(1));
  act(() => opts.onMessage?.({ source: 'user', role: 'user', event_id: 3, message: 'late yes' }));
  expect(f.endSession).toHaveBeenCalledOnce();
  expect(f.entries()).toEqual([
    expect.objectContaining({
      role: 'agent',
      seq: 1,
      text: 'Co',
      interrupted: true,
      timestamp: expect.any(String),
    }),
  ]);
  expect(screen.queryByText('late yes')).toBeNull();
});
it('closes dropped conversations and reconnects with a fresh identity and sequence', async () => {
  const f = fixture(),
    first = await f.begin();
  act(() =>
    first.onDisconnect?.({ reason: 'error', message: 'dropped', context: { type: 'socket' } }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  await waitFor(() => expect(screen.getByText('Start Voice')).toBeEnabled());
  const next = await f.begin();
  act(() =>
    next.onMessage?.({ role: 'user', source: 'user', event_id: 1, message: 'another session' }),
  );
  await waitFor(() => expect(f.entries()).toHaveLength(1));
  expect(f.finals()[0]!.body['session_id']).toBe('session-1');
  expect(f.requests.at(-1)?.body).toMatchObject({
    session_id: 'session-2',
    entries: [{ seq: 1, text: 'another session' }],
  });
});
it('uses corrected interrupted speech and logs complete readbacks in order', async () => {
  const f = fixture(),
    opts = await f.begin();
  act(() => {
    opts.onMessage?.({
      role: 'agent',
      source: 'ai',
      event_id: 1,
      message: 'Please confirm the terms',
    });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onInterruption?.({ event_id: 1 });
    opts.onModeChange?.({ mode: 'listening' });
    opts.onAgentResponseCorrection?.({
      event_id: 1,
      original_agent_response: 'Please confirm the terms',
      corrected_agent_response: 'Please',
    });
    opts.onMessage?.({ role: 'user', source: 'user', event_id: 2, message: 'change it' });
    opts.onMessage?.({
      role: 'agent',
      source: 'ai',
      event_id: 3,
      message: 'New terms. Say yes to confirm.',
    });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onModeChange?.({ mode: 'listening' });
    opts.onMessage?.({ role: 'user', source: 'user', event_id: 4, message: 'yes' });
  });
  await waitFor(() => expect(f.entries()).toHaveLength(4));
  expect(f.entries().map((e) => [e.seq, e.text, !!e.interrupted])).toEqual([
    [1, 'Please', true],
    [2, 'change it', false],
    [3, 'New terms. Say yes to confirm.', false],
    [4, 'yes', false],
  ]);
});
it('retries a lost capture response once with the original key and body', async () => {
  const f = fixture(),
    opts = await f.begin();
  const original = f.fetchMock.getMockImplementation()!;
  const attempts: { key: string; body: BodyInit | null | undefined }[] = [];
  f.fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith('/capture_order_intent')) {
      attempts.push({
        key: (init.headers as Record<string, string>)['Idempotency-Key']!,
        body: init.body,
      });
      if (attempts.length === 1) throw new TypeError('Network response lost');
    }
    return original(path, init);
  });
  await act(async () => {
    const result = JSON.parse(
      await opts.clientTools['capture_order_intent']!({
        venue: 'gemini_prediction',
        instrument: 'BTC-150K-2026',
        side: 'yes',
        quantity: 1,
        limit_price: 0.18,
        confirmed_by_user: true,
        utterance: 'bitcoin',
      }),
    );
    expect(result.ok).toBe(true);
  });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(f.entries().filter((entry) => entry.role === 'tool')).toHaveLength(1);
});
it('returns the frozen failure hint after a second network failure', async () => {
  const f = fixture(),
    opts = await f.begin();
  const original = f.fetchMock.getMockImplementation()!;
  let attempts = 0;
  f.fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith('/get_order_status')) {
      attempts++;
      throw new TypeError('offline');
    }
    return original(path, init);
  });
  await act(async () => {
    const result = JSON.parse(
      await opts.clientTools['get_order_status']!({
        venue: 'gemini_spot',
        query: 'btc',
        utterance: 'bitcoin',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      simulated: true,
      error: { code: 'backend_unavailable' },
    });
  });
  expect(attempts).toBe(2);
  expect(f.entries()[0].text).toContain('Do not say anything was prepared.');
});
it('replays missing evidence before retrying a transcript_not_synced tool call', async () => {
  const f = fixture(),
    opts = await f.begin();
  act(() => opts.onMessage?.({ role: 'user', source: 'user', event_id: 1, message: 'bitcoin' }));
  await waitFor(() => expect(f.entries()).toHaveLength(1));
  const original = f.fetchMock.getMockImplementation()!;
  const keys: string[] = [];
  f.fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith('/get_order_status')) {
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
      if (keys.length === 1)
        return Response.json(
          { ok: false, simulated: true, error: { code: 'transcript_not_synced', expected_seq: 1 } },
          { status: 409 },
        );
    }
    return original(path, init);
  });
  await act(async () => {
    const result = JSON.parse(
      await opts.clientTools['get_order_status']!({
        venue: 'gemini_spot',
        query: 'btc',
        utterance: 'bitcoin',
      }),
    );
    expect(result.ok).toBe(true);
  });
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(f.entries().map((entry) => entry.seq)).toEqual([1, 1, 2]);
});

it('waits for a late playback completion before flushing the yes to the tool', async () => {
  const f = fixture(),
    opts = await f.begin();
  const text = 'Buy 1 YES contract at 18 cents. Say yes to confirm.';
  let result!: Promise<string>;
  act(() => {
    opts.onMessage?.({ role: 'agent', source: 'ai', message: text, event_id: 1 });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onMessage?.({ role: 'user', source: 'user', message: 'yes', event_id: 2 });
    result = opts.clientTools['capture_order_intent']!({});
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.requests.some((r) => r.path.endsWith('/capture_order_intent'))).toBe(false);
  await act(async () => {
    opts.onModeChange?.({ mode: 'listening' });
    await result;
  });
  expect(
    f
      .entries()
      .slice(0, 2)
      .map((e) => [e.text, !!e.interrupted]),
  ).toEqual([
    [text, false],
    ['yes', false],
  ]);
  expect(
    f.requests.find((r) => r.path.endsWith('/capture_order_intent'))?.body['last_transcript_seq'],
  ).toBe(2);
});

it('accepts a fully played alignment if the playback-end event was lost', async () => {
  const f = fixture(),
    opts = await f.begin();
  const text = 'Buy 1 YES contract at 18 cents. Say yes to confirm.';
  act(() => {
    opts.onMessage?.({ role: 'agent', source: 'ai', message: text, event_id: 1 });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onAudioAlignmentPlayback?.({
      event_id: 1,
      alignment: {
        chars: [text.toLowerCase().slice(0, -1)],
        char_start_times_ms: [0],
        char_durations_ms: [0],
      },
    });
    opts.onMessage?.({ role: 'user', source: 'user', message: 'yes', event_id: 2 });
  });
  await waitFor(() => expect(f.entries()).toHaveLength(2));
  expect(f.entries()[0]).toMatchObject({ text });
  expect(f.entries()[0].interrupted).toBeUndefined();
});

it.each([false, true])(
  'rejects unverifiable playback when a yes arrives (partial alignment %s)',
  async (partial) => {
    const f = fixture(),
      opts = await f.begin();
    act(() => {
      opts.onMessage?.({
        role: 'agent',
        source: 'ai',
        message: 'Buy one. Say yes to confirm.',
        event_id: 1,
      });
      opts.onModeChange?.({ mode: 'speaking' });
      if (partial) {
        opts.onAudioAlignmentPlayback?.({
          event_id: 1,
          alignment: { chars: ['Buy'], char_start_times_ms: [0], char_durations_ms: [0] },
        });
        opts.onModeChange?.({ mode: 'listening' });
      }
      opts.onMessage?.({ role: 'user', source: 'user', message: 'yes', event_id: 2 });
    });
    await waitFor(() => expect(f.entries()).toHaveLength(2));
    expect(f.entries()[0]).toMatchObject({ text: partial ? 'Buy' : '', interrupted: true });
  },
);

it('records a late interruption and corrected prefix before the waiting yes', async () => {
  const f = fixture(),
    opts = await f.begin();
  const text = 'Buy one. Say yes to confirm.';
  act(() => {
    opts.onMessage?.({ role: 'agent', source: 'ai', message: text, event_id: 1 });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onMessage?.({ role: 'user', source: 'user', message: 'yes', event_id: 2 });
    opts.onInterruption?.({ event_id: 1 });
    opts.onModeChange?.({ mode: 'listening' });
    opts.onAgentResponseCorrection?.({
      event_id: 1,
      original_agent_response: text,
      corrected_agent_response: 'Buy one.',
    });
  });
  await waitFor(() => expect(f.entries()).toHaveLength(2));
  expect(f.entries()[0]).toMatchObject({ text: 'Buy one.', interrupted: true });
  expect(f.entries()[1].text).toBe('yes');
});

it('keeps early alignment for the next response while the previous draft is pending', async () => {
  const f = fixture(),
    opts = await f.begin();
  const text = 'Buy one. Say yes to confirm.';
  act(() => {
    opts.onMessage?.({ role: 'agent', source: 'ai', event_id: 1, message: 'Earlier response.' });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onAudioAlignmentPlayback?.({
      event_id: 2,
      alignment: { chars: [text], char_start_times_ms: [0], char_durations_ms: [0] },
    });
    opts.onMessage?.({ role: 'agent', source: 'ai', event_id: 2, message: text });
    opts.onMessage?.({ role: 'user', source: 'user', event_id: 3, message: 'yes' });
  });
  await waitFor(() => expect(f.entries()).toHaveLength(3));
  expect(f.entries()[0]).toMatchObject({ text: '', interrupted: true });
  expect(f.entries()[1]).toMatchObject({ text });
  expect(f.entries()[1].interrupted).toBeUndefined();
});

it('preserves a correction arriving after the turn was stored and closes the session', async () => {
  const f = fixture(),
    opts = await f.begin();
  const text = 'Buy one. Say yes to confirm.';
  act(() => {
    opts.onMessage?.({ role: 'agent', source: 'ai', event_id: 1, message: text });
    opts.onModeChange?.({ mode: 'speaking' });
    opts.onModeChange?.({ mode: 'listening' });
  });
  await waitFor(() => expect(f.entries()).toHaveLength(1));
  act(() =>
    opts.onAgentResponseCorrection?.({
      event_id: 1,
      original_agent_response: text,
      corrected_agent_response: 'Buy',
    }),
  );
  await waitFor(() => expect(f.finals()).toHaveLength(1));
  expect(f.entries()[1]).toMatchObject({ text: 'Buy', interrupted: true });
  expect(screen.getByRole('alert')).toHaveTextContent('Start voice for a new readback');
});

it('shares fresh sandbox reads between the dashboard and SDK without session tokens or order calls', async () => {
  const f = fixture(), sdk = await f.begin();
  const event = { ticker: 'E', title: 'Event title', contracts: [{ symbol: 'C', label: 'Contract' }] };
  const quote = { ok: true, title: event.title, contract: { ...event.contracts[0], buy: { yes: 0.17, no: null }, sell: { yes: 0.12, no: 0.8 } } };
  const requests: string[] = [];
  f.fetchMock.mockImplementation(async (path, init) => {
    requests.push(path);
    expect(init.headers).toBeUndefined();
    return Response.json(path.includes('/search_markets?') ? { ok: true, events: [event] } : quote);
  });
  fireEvent.click(screen.getByRole('button', {name:'Search markets'}));
  fireEvent.click(await screen.findByRole('button', {name:'Quote Contract'}));
  expect(await screen.findByText('YES · buy 17¢ · sell 12¢')).toBeInTheDocument();
  expect(screen.getByText('NO · buy unavailable · sell 80¢')).toBeInTheDocument();
  await act(async () => {
    expect(JSON.parse(await sdk.clientTools['search_markets']!({query:''})).events).toEqual([event]);
    expect(JSON.parse(await sdk.clientTools['get_orderbook']!({event_ticker:'E', contract_symbol:'C'}))).toEqual(quote);
  });
  expect(requests.slice(0,2)).toEqual(requests.slice(2));
  expect(requests).toHaveLength(4);
});

it('shows a voice proposal and accepts its private approval only from the dashboard',async()=>{
  const f=fixture(),sdk=await f.begin();
  const proposal={proposal_id:'id',title:'Event',contract_label:'Threshold',instrument_symbol:'C',outcome:'yes',quantity:2,limit_price:.4,quote_price:.39,notional_usd:.8,est_fee_usd:.04,expires_at:new Date(Date.now()+60000).toISOString(),readback:'Buy 2 YES contracts at up to 40 cents.'};
  const calls:{path:string;init:RequestInit}[]=[];
  f.fetchMock.mockImplementation(async(path,init)=>{
    calls.push({path,init});return Response.json(path.endsWith('/proposals')?{ok:true,proposal,availability:{execution_enabled:true,message:'Sandbox enabled'}}:{ok:true,say:'Filled 2 contracts.'});
  });
  expect(Object.keys(sdk.clientTools)).not.toContain('approve');
  let spoken='';
  await act(async()=>{spoken=await sdk.clientTools['prepare_sandbox_buy']!({event_ticker:'E',contract_symbol:'C',outcome:'yes',quantity:2,limit_price:.4})});
  expect(JSON.parse(spoken).proposal.readback).toEqual(proposal.readback);
  expect(screen.getByText(proposal.readback)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Private approval PIN'),{target:{value:'6739'}});
  fireEvent.click(screen.getByRole('button',{name:'Approve sandbox buy'}));
  expect(await screen.findByText('Filled 2 contracts.')).toBeInTheDocument();
  expect(calls.map(c=>c.path)).toEqual(['/api/trading/proposals','/api/trading/approve']);
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({proposal_id:'id',pin:'6739'});
  expect(calls[1]!.init.headers).toMatchObject({Authorization:'Bearer private-1'});
  expect(spoken).not.toContain('6739');
});

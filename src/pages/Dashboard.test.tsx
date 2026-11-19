import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      lastSeq = body.entries.at(-1)?.seq ?? lastSeq;
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
  const finals = () => requests.filter((r) => r.body.final);
  const entries = () =>
    requests.filter((r) => r.path.endsWith('/transcripts')).flatMap((r) => r.body.entries);
  return { mic, stopTrack, endSession, requests, begin, finals, entries, fetchMock };
}
it('explains microphone denial before signing and allows another attempt', async () => {
  const f = fixture();
  f.mic.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
  fireEvent.click(screen.getByText('Start Voice'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Microphone blocked');
  expect(f.requests).toHaveLength(0);
  await f.begin();
  expect(f.stopTrack).toHaveBeenCalledOnce();
});
it('flushes before a tool, returns its JSON, persists tool evidence and shows captured intents', async () => {
  const f = fixture(),
    opts = await f.begin();
  expect(start.mock.calls[0][0]).toMatchObject({
    signedUrl: 'wss://mock.test/1',
    connectionType: 'websocket',
  });
  act(() => opts.onMessage?.({ role: 'user', source: 'user', event_id: 1, message: 'bitcoin' }));
  let result = '';
  await act(async () => {
    result = await opts.clientTools.search_markets({
      venue: 'gemini_spot',
      query: 'btc',
      utterance: 'bitcoin',
    });
  });
  expect(JSON.parse(result)).toEqual({ ok: true, simulated: true, count: 1 });
  const at = f.requests.findIndex((r) => r.path.endsWith('/search_markets'));
  expect(f.requests.slice(0, at).some((r) => r.body.entries?.[0]?.text === 'bitcoin')).toBe(true);
  expect(f.requests[at].body).toMatchObject({
    last_transcript_seq: 1,
    session_id: 'session-1',
    parameters: { limit: null },
  });
  expect(f.requests[at].headers.Authorization).toBe('Bearer private-1');
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
  expect(f.finals()[0].body.session_id).toBe('session-1');
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
it('retries a lost tool response once with the original key and body', async () => {
  const f = fixture(),
    opts = await f.begin();
  const original = f.fetchMock.getMockImplementation()!;
  const attempts: { key: string; body: BodyInit | null | undefined }[] = [];
  f.fetchMock.mockImplementation(async (path, init) => {
    if (path.endsWith('/get_orderbook')) {
      attempts.push({
        key: (init.headers as Record<string, string>)['Idempotency-Key'],
        body: init.body,
      });
      if (attempts.length === 1) throw new TypeError('Network response lost');
    }
    return original(path, init);
  });
  await act(async () => {
    const result = JSON.parse(
      await opts.clientTools.get_orderbook({
        venue: 'gemini_spot',
        instrument: 'BTCUSD',
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
    if (path.endsWith('/search_markets')) {
      attempts++;
      throw new TypeError('offline');
    }
    return original(path, init);
  });
  await act(async () => {
    const result = JSON.parse(
      await opts.clientTools.search_markets({
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
    if (path.endsWith('/search_markets')) {
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
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
      await opts.clientTools.search_markets({
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

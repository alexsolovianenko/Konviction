import { afterEach, expect, it, vi } from 'vitest';
import { Session } from './session';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const start = () =>
  new Session(
    { session_token: 'secret', session_id: 'session', signed_url: 'wss://test' },
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('bounds flush plus retry plus response at nine seconds and aborts the in-flight request', async () => {
  vi.useFakeTimers();
  const attempts: RequestInit[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/transcripts')) {
      await sleep(2800);
      return Response.json({ last_seq: 0 });
    }
    attempts.push(init);
    if (attempts.length === 1) {
      await sleep(2800);
      throw new Error('lost response');
    }
    return new Promise((_, reject) =>
      init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  const session = start();
  const answer = session.tools.get_orderbook({});
  await vi.advanceTimersByTimeAsync(8999);
  expect(attempts).toHaveLength(2);
  expect(session.entries).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.parse(await answer).error.code).toBe('backend_unavailable');
  expect(attempts[1].signal?.aborted).toBe(true);
  expect(attempts[0].headers).toEqual(attempts[1].headers);
  expect(session.entries).toHaveLength(1);
});

it('expires in the queue and never starts that capture after the agent received an error', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let stored = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/transcripts')) {
      await blocked;
      const entries = JSON.parse(String(init.body)).entries;
      stored = entries.at(-1)?.seq ?? stored;
      return Response.json({ last_seq: stored });
    }
    throw new Error('unexpected tool request');
  });
  vi.stubGlobal('fetch', fetchMock);
  const session = start();
  session.append({ role: 'user', text: 'yes' });
  const answer = session.tools.capture_order_intent({});
  await vi.advanceTimersByTimeAsync(9000);
  expect(JSON.parse(await answer).error.code).toBe('backend_unavailable');
  release();
  await session.close();
  expect(fetchMock.mock.calls.every(([path]) => path.endsWith('/transcripts'))).toBe(true);
  expect(session.entries.filter((e) => e.role === 'tool')).toHaveLength(1);
});

it('returns the completed result even if the audit flush and dashboard refresh are slow', async () => {
  vi.useFakeTimers();
  const session = start();
  const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/transcripts')) {
      const entries = JSON.parse(String(init.body)).entries;
      if (entries.length) await sleep(3000);
      return Response.json({ last_seq: entries.at(-1)?.seq ?? 0 });
    }
    await sleep(3000);
    return Response.json(path.includes('/intents?') ? { intents: [] } : { ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  const answer = session.tools.search_markets({});
  await vi.advanceTimersByTimeAsync(3000);
  expect(JSON.parse(await answer)).toEqual({ ok: true });
  expect(fetchMock.mock.calls.some(([path]) => path.includes('/intents?'))).toBe(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(fetchMock.mock.calls.some(([path]) => path.includes('/intents?'))).toBe(true);
});

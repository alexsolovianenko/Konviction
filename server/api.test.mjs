import { legacyMarket } from './test-support/legacy-markets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { api, compile, intentSchema, validIntent } from './contracts.mjs';
import { SQLiteRepository } from './repository.mjs';
import { createApi } from './api.mjs';

const evals = JSON.parse(readFileSync(new URL('../evals/utterances.json', import.meta.url)));
const [first, yes] = evals.cases.find((c) => c.id === 'pred-01').turns;
const place = yes.expect.calls[0].args;
const venue = 'gemini_prediction';
const readback = first.expect.reply_exact;
const validators = new Map();
function checkSchema(schema, value) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) validators.set(key, compile(schema));
  const validate = validators.get(key);
  assert.ok(validate(value), JSON.stringify(validate.errors));
}
function matches(name, value) {
  checkSchema({ $ref: '#/components/schemas/' + name }, value);
}
async function setup(t, overrides = {}) {
  let now = Date.parse('2026-11-19T15:03:00Z');
  const repo = new SQLiteRepository(overrides.path ?? ':memory:');
  const upstream = async (url, options) => {
    assert.equal(
      url.origin + url.pathname,
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url',
    );
    assert.equal(url.searchParams.get('agent_id'), 'private');
    assert.equal(options.headers['xi-api-key'], 'secret');
    return Response.json({ signed_url: 'wss://api.elevenlabs.io/conversation?signature=mock' });
  };
  const server = createApi({
    repo,
    legacyMarket,
    lookupInstrument: async (symbol, venue) => api['x-simulated-catalog'][venue]?.find(c => c.instrument === symbol),
    apiKey: 'secret',
    agentId: 'private',
    upstream,
    clock: () => now,
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repo.close();
  });
  const request = async (path, body, token, key) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: 'Bearer ' + token }),
        ...(key && { 'Idempotency-Key': key }),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    const operation = api.paths[path.split('?')[0]][body === undefined ? 'get' : 'post'];
    const spec = operation.responses[response.status];
    const responseSpec = spec?.$ref ? api.components.responses[spec.$ref.split('/').at(-1)] : spec;
    if (responseSpec) checkSchema(responseSpec.content['application/json'].schema, data);
    else if (data.error) matches('Error', data);
    return { status: response.status, data, headers: response.headers };
  };
  const start = async () => {
    const issued = await request('/voice/signed-url', {});
    assert.equal(issued.status, 201);
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    const { session_id, session_token } = issued.data;
    let seq = 0;
    const post = (path, body, key) => request(path, { session_id, ...body }, session_token, key);
    const entry = (role, text, extra = {}) => ({
      role,
      text,
      seq: ++seq,
      timestamp: new Date(now).toISOString(),
      ...extra,
    });
    const append = (...entries) => post('/transcripts', { entries });
    const tool = (name, parameters, key = randomUUID(), last_transcript_seq = seq) =>
      post('/tools/' + name, { last_transcript_seq, parameters }, key);
    const list = (query = '') =>
      request('/intents?session_id=' + session_id + query, undefined, session_token);
    return { entry, append, tool, list, post, session_id, session_token };
  };
  return {
    start,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/api',
    request,
    repo,
    advance: (ms) => {
      now += ms;
    },
  };
}
function code(response, status, expected) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.equal(response.data.error.code, expected);
}

test('frozen examples validate; incompatible intent types and fields fail', () => {
  for (const example of intentSchema.examples) {
    assert.ok(validIntent(example));
    assert.equal(validIntent({ ...example, status: 'executed' }), false);
    assert.equal(validIntent({ ...example, undocumented: true }), false);
  }
  assert.equal(Object.values(api.paths).flatMap(Object.keys).length, 9);
});
test('signing fails closed on missing config and upstream errors', async (t) => {
  for (const [options, status, expected] of [
    [{ apiKey: '' }, 503, 'voice_not_configured'],
    [
      { upstream: () => Response.json({ signed_url: 'https://invalid.test' }) },
      502,
      'elevenlabs_unavailable',
    ],
  ]) {
    const { request } = await setup(t, options);
    code(await request('/voice/signed-url', {}), status, expected);
  }
});
test('complete simulated workflow, replay and aliases, status/cancel resolution and list filters', async (t) => {
  const app = await setup(t),
    s = await app.start();
  await s.append(s.entry('user', first.user));
  const key = randomUUID(),
    search = { venue, query: first.expect.calls[0].args.query, utterance: first.user };
  const query = await s.tool('search_markets', search, key);
  matches('SearchMarketsResult', query.data);
  assert.equal(query.data.results[0].instrument, place.instrument);
  assert.deepEqual((await s.tool('search_markets', search, key)).data, query.data);
  code(await s.tool('search_markets', { ...search, limit: 1 }, key), 409, 'idempotency_key_reused');
  const book = await s.tool('get_orderbook', {
    venue,
    instrument: place.instrument,
    depth: 2,
    utterance: 'invented',
  });
  matches('OrderbookResult', book.data);
  assert.equal(book.data.bids.length, 2);
  await s.append(s.entry('agent', readback), s.entry('user', 'Yeah, that’s right.'));
  const captureKey = randomUUID();
  const created = await s.post(
    '/intents',
    { intent: 'place_order', last_transcript_seq: 3, ...place },
    captureKey,
  );
  assert.equal(created.status, 201);
  matches('CaptureResult', created.data);
  const target = created.data.intent.id;
  const duplicate = await s.tool('capture_order_intent', place);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.intent.id, target);
  await s.append(
    s.entry('user', 'cancel my order'),
    s.entry('agent', readback.replace('buy', 'cancel your prepared order to buy')),
    s.entry('user', 'yes'),
  );
  const cancel = { venue, order_id: target, utterance: 'cancel my order', confirmed_by_user: true };
  code(
    await s.tool('capture_cancel_intent', { ...cancel, instrument: 'SOLUSD' }),
    422,
    'instrument_mismatch',
  );
  const cancelled = await s.tool('capture_cancel_intent', cancel);
  assert.equal(cancelled.status, 201);
  matches('CaptureResult', cancelled.data);
  const status = await s.tool('get_order_status', {
    venue,
    utterance: 'cancel my order',
    order_id: target,
  });
  matches('OrderStatusResult', status.data);
  assert.equal(status.data.matches[0].cancel_captured, true);
  await s.append(
    s.entry('agent', readback.replace('buy', 'cancel your prepared order to buy')),
    s.entry('user', 'yes'),
  );
  code(await s.tool('capture_cancel_intent', cancel), 409, 'cancel_already_captured');
  code(
    await s.tool('capture_cancel_intent', { ...cancel, order_id: status.data.query_intent_id }),
    422,
    'order_not_cancellable',
  );
  const intents = (await s.list()).data.intents;
  assert.equal(intents.length, 5);
  assert.ok(intents.every((i) => validIntent(i)));
  assert.equal(intents.find((i) => i.id === book.data.query_intent_id).utterance, first.user);
  assert.equal((await s.list('&intent=place_order&limit=1')).data.intents[0].id, target);
  await s.post('/transcripts', { entries: [], final: true });
  assert.deepEqual(
    (
      await s.post(
        '/intents',
        { intent: 'place_order', last_transcript_seq: 3, ...place },
        captureKey,
      )
    ).data,
    created.data,
  );
  code(await s.tool('capture_order_intent', place), 409, 'session_ended');
  assert.equal((await s.list()).status, 200);
});
test('transcript conflicts, gaps, rollback, sync retry, isolation and expiry', async (t) => {
  const app = await setup(t),
    s = await app.start(),
    other = await app.start();
  const one = s.entry('user', 'bitcoin'),
    two = s.entry('agent', 'hello');
  code(await s.append(one, { ...two, seq: 3 }), 409, 'seq_gap');
  assert.equal((await s.append(one)).data.accepted, 1);
  assert.equal((await s.append(one)).data.accepted, 0);
  code(await s.append({ ...one, text: 'changed' }), 409, 'seq_conflict');
  const key = randomUUID(),
    search = { venue, query: 'bitcoin', utterance: 'bitcoin' };
  code(await s.tool('search_markets', search, key, 2), 409, 'transcript_not_synced');
  await s.append(two);
  assert.equal((await s.tool('search_markets', search, key, 2)).status, 200);
  assert.equal((await other.list()).data.count, 0);
  code(
    await app.request('/intents?session_id=' + s.session_id, undefined, other.session_token),
    401,
    'unauthorized',
  );
  code(await app.request('/intents?session_id=' + s.session_id), 401, 'unauthorized');
  app.advance(600000);
  code(await s.append(s.entry('user', 'late')), 409, 'session_ended');
  assert.equal((await s.list()).status, 200);
  app.advance(3000000);
  code(await s.list(), 404, 'session_not_found');
});
test('domain and transcript confirmation precedence; failed attempts never capture', async (t) => {
  const app = await setup(t),
    s = await app.start();
  const reject = async (params, expected, status = 422) =>
    code(await s.tool('capture_order_intent', { ...place, ...params }), status, expected);
  await reject({ unexpected: true }, 'invalid_parameters', 400);
  await reject({ instrument: 'FAKE' }, 'unknown_instrument');
  await reject({ side: 'sell' }, 'invalid_parameters', 400);
  await reject({ quantity: 1e-9 }, 'invalid_parameters', 400);
  await reject({ limit_price: 0.121 }, 'invalid_price');
  await reject({ confirmed_by_user: false }, 'confirmation_required');
  await reject({}, 'confirmation_missing');
  await s.append(s.entry('user', first.user), s.entry('user', 'yes'));
  await reject({}, 'confirmation_missing');
  await s.append(s.entry('agent', readback, { interrupted: true }), s.entry('user', 'yes'));
  await reject({}, 'readback_interrupted');
  await s.append(s.entry('agent', readback), s.entry('user', 'yes but make it two'));
  await reject({}, 'confirmation_missing');
  await s.append(s.entry('agent', readback), s.entry('user', 'yes'));
  await reject({ quantity: 2 }, 'readback_mismatch');
  await reject({ utterance: 'fabricated' }, 'utterance_mismatch');
  app.advance(120001);
  await reject({}, 'confirmation_missing');
  assert.equal((await s.list()).data.count, 0);
});
test('prediction book, cent readback, numeric normalization and spoken order reference', async (t) => {
  const app = await setup(t),
    s = await app.start();
  const prediction = {
    venue: 'gemini_prediction',
    instrument: 'FED-CUT-DEC26',
    side: 'no',
    quantity: 10,
    limit_price: 0.29,
    confirmed_by_user: true,
    utterance: 'buy ten no at twenty nine cents',
  };
  await s.append(
    s.entry('user', prediction.utterance),
    s.entry(
      'agent',
      'Buy 10 no contracts of FED-CUT-DEC26 on Gemini prediction at 29 cents. Say yes to confirm.',
    ),
    s.entry('user', 'yep please'),
  );
  assert.equal((await s.tool('capture_order_intent', prediction)).status, 201);
  code(
    await s.tool('capture_order_intent', { ...prediction, quantity: 0.5 }),
    400,
    'invalid_parameters',
  );
  code(
    await s.tool('capture_order_intent', { ...prediction, limit_price: 1 }),
    400,
    'invalid_parameters',
  );
  const book = await s.tool('get_orderbook', {
    venue: prediction.venue,
    instrument: prediction.instrument,
    utterance: prediction.utterance,
  });
  assert.equal(book.data.spread, 0.01);
  const utterance = 'cancel a b dash one two three';
  await s.append(
    s.entry('user', utterance),
    s.entry('agent', 'Cancel order AB123 on Gemini prediction. Say yes to confirm.'),
    s.entry('user', 'yes'),
  );
  const cancel = { venue, order_id: 'ab-123', utterance, confirmed_by_user: true };
  assert.equal((await s.tool('capture_cancel_intent', cancel)).data.intent.order_id, 'AB123');
  code(
    await s.tool('capture_cancel_intent', { ...cancel, order_id: 'MADEUP' }),
    422,
    'order_id_not_user_supplied',
  );
});
test('SQLite records and replay survive a second repository connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-')),
    path = join(dir, 'test.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await setup(t, { path }),
    s = await app.start();
  await s.append(s.entry('user', 'bitcoin'));
  const key = randomUUID();
  await s.tool('search_markets', { venue, query: 'btc', utterance: 'bitcoin' }, key);
  const other = new SQLiteRepository(path);
  try {
    assert.equal(other.transcript(s.session_id)[0].text, 'bitcoin');
    assert.equal(other.intents(s.session_id).length, 1);
    assert.ok(other.replay(s.session_id, key));
  } finally {
    other.close();
  }
});
test('concurrent submissions consume one confirmation and replay the same bytes', async (t) => {
  const app = await setup(t),
    s = await app.start();
  await s.append(s.entry('user', first.user), s.entry('agent', readback), s.entry('user', 'yes'));
  const key = randomUUID(),
    submit = () => s.tool('capture_order_intent', place, key);
  const [a, b] = await Promise.all([submit(), submit()]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(JSON.stringify(a.data), JSON.stringify(b.data));
  assert.equal((await s.list()).data.count, 1);
});
test('bounds audit copies by Unicode code point and keeps the original speech', async (t) => {
  const app = await setup(t),
    s = await app.start();
  const query = { venue, query: 'bitcoin', utterance: 'absent from transcript' };
  code(await s.tool('search_markets', query), 422, 'utterance_mismatch');
  const speech = '🍁'.repeat(1999) + '問more';
  await s.append(s.entry('user', speech), s.entry('user', '...'));
  const search = '  ' + '𐐀'.repeat(65) + '  ';
  assert.equal((await s.tool('search_markets', { ...query, query: search })).status, 200);
  const [audit] = (await s.list()).data.intents;
  assert.equal(audit.instrument, '𐐀'.repeat(64));
  assert.equal(audit.utterance, '🍁'.repeat(1999) + '問');
  assert.equal(app.repo.transcript(s.session_id)[0].text, speech);
});
test('readback retains decimal points, signed numbers and thousands separators', async (t) => {
  const app = await setup(t);
  const s = await app.start();
  await s.append(
    s.entry('user', first.user),
    s.entry('agent', readback.replace('62 cents', '-62 cents')),
    s.entry('user', 'yes'),
  );
  code(await s.tool('capture_order_intent', place), 422, 'readback_mismatch');
  await s.append(
    s.entry('agent', readback.replace('10 yes', '1,000 yes').replace('62 cents', '.620 dollars')),
    s.entry('user', 'yes'),
  );
  code(await s.tool('capture_order_intent', { ...place, quantity: 620 }), 422, 'readback_mismatch');
  assert.equal((await s.tool('capture_order_intent', { ...place, quantity: 1000 })).status, 201);
});

test('confirmation freshness uses the first server receipt regardless of browser clock or transcript replay', async (t) => {
  const app = await setup(t);
  for (const timestamp of ['2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z']) {
    const s = await app.start();
    const user = s.entry('user', first.user);
    const agent = s.entry('agent', readback);
    const yesEntry = s.entry('user', 'yes', { timestamp });
    await s.append(user, agent, yesEntry);
    app.advance(120000);
    assert.equal((await s.tool('capture_order_intent', place)).status, 201);
    app.advance(1);
    assert.equal((await s.append(yesEntry)).data.accepted, 0);
    code(await s.tool('capture_order_intent', place), 422, 'confirmation_missing');
    assert.equal(app.repo.transcript(s.session_id).at(-1).timestamp, timestamp);
  }
});

test('legacy SQLite migration preserves the transcript and requires a fresh confirmation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-capture-'));
  const path = join(dir, 'capture.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = randomUUID(),
    token = randomUUID(),
    now = Date.parse('2026-11-19T15:03:00Z');
  const entries = [first.user, readback, 'yes'].map((text, i) => ({
    text,
    role: i === 1 ? 'agent' : 'user',
    seq: i + 1,
    timestamp: new Date(now).toISOString(),
  }));
  const old = new DatabaseSync(path);
  old.exec(
    'CREATE TABLE transcript(session TEXT, seq INTEGER, entry TEXT, PRIMARY KEY(session,seq))',
  );
  for (const entry of entries)
    old.prepare('INSERT INTO transcript VALUES (?,?,?)').run(id, entry.seq, JSON.stringify(entry));
  old.close();
  const app = await setup(t, { path });
  app.repo.create(
    id,
    createHash('sha256').update(token).digest('hex'),
    now,
    now + 3600000,
    now + 900000,
  );
  const capture = (seq) =>
    app.request(
      '/tools/capture_order_intent',
      { session_id: id, last_transcript_seq: seq, parameters: place },
      token,
      randomUUID(),
    );
  assert.deepEqual(app.repo.transcript(id), entries);
  assert.equal(app.repo.receivedAt(id, 3), null);
  const retry = await app.request('/transcripts', { session_id: id, entries }, token);
  assert.equal(retry.data.accepted, 0);
  code(await capture(3), 422, 'confirmation_missing');
  await app.request(
    '/transcripts',
    {
      session_id: id,
      entries: [
        { ...entries[1], seq: 4 },
        { ...entries[2], seq: 5 },
      ],
    },
    token,
  );
  assert.equal((await capture(5)).status, 201);
});

test('replays the original cached capture error after its confirmation expires', async (t) => {
  const app = await setup(t),
    s = await app.start();
  await s.append(s.entry('user', first.user), s.entry('agent', readback), s.entry('user', 'yes'));
  const key = randomUUID(),
    params = { ...place, quantity: 9 };
  const firstError = await s.tool('capture_order_intent', params, key);
  code(firstError, 422, 'readback_mismatch');
  app.advance(120001);
  const replay = await s.tool('capture_order_intent', params, key);
  assert.deepEqual(replay.data, firstError.data);
  code(await s.tool('capture_order_intent', params), 422, 'confirmation_missing');
  assert.equal((await s.list()).data.count, 0);
});

test('losing the committed capture response and retrying returns the original intent exactly once', async (t) => {
  const app = await setup(t),
    s = await app.start(),
    key = randomUUID();
  await s.append(s.entry('user', first.user), s.entry('agent', readback), s.entry('user', 'yes'));
  const payload = { session_id: s.session_id, last_transcript_seq: 3, parameters: place };
  // Drop the first response at its headers, after SQLite committed but before the client read the intent.
  await new Promise((resolve, reject) => {
    const req = httpRequest(
      app.baseUrl + '/tools/capture_order_intent',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + s.session_token,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
      },
      (res) => {
        const status = res.statusCode;
        res.destroy();
        resolve(status);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  }).then((status) => assert.equal(status, 201));
  app.advance(120001);
  const retried = await s.tool('capture_order_intent', place, key);
  assert.equal(retried.status, 201);
  const listed = (await s.list()).data;
  assert.equal(listed.count, 1);
  assert.deepEqual(retried.data.intent, listed.intents[0]);
});

for (const fixture of evals.backend_regressions) {
  test('frozen backend regression ' + fixture.id, async (t) => {
    const app = await setup(t),
      s = await app.start();
    for (const { role, text, age_seconds = 0, ...metadata } of fixture.transcript) {
      const entry = s.entry(role, text, metadata);
      entry.timestamp = new Date(Date.parse(entry.timestamp) - age_seconds * 1000).toISOString();
      assert.equal((await s.append(entry)).status, 200);
    }
    app.advance((fixture.advance_server_clock_seconds ?? 0) * 1000);
    const { status, data } = await s.tool(fixture.call.tool, fixture.call.args);
    const { intents } = (await s.list()).data;
    const audit = intents.find((i) => i.id === data.query_intent_id);
    const transcript = app.repo.transcript(s.session_id);
    const observed = {
      status,
      code: data.error?.code,
      count: data.count,
      instruments: data.results?.map((item) => item.instrument),
      audit_instrument: audit?.instrument,
      audit_order_id: audit?.order_id,
      audit_utterance: audit?.utterance,
      audit_utterance_length: audit && Array.from(audit.utterance).length,
      transcript_text_length: transcript[0] && Array.from(transcript[0].text).length,
      intents_stored: intents.length,
    };
    for (const [key, expected] of Object.entries(fixture.expect))
      assert.deepEqual(observed[key], expected, key);
  });
}

test('a late ASR fragment extending a consumed yes cannot create another capture', async (t) => {
  const app = await setup(t),
    s = await app.start();
  await s.append(s.entry('user', first.user), s.entry('agent', readback), s.entry('user', 'yes'));
  const firstCapture = await s.tool('capture_order_intent', place);
  assert.equal(firstCapture.status, 201);
  await s.append(
    s.entry('tool', JSON.stringify(firstCapture.data), { tool_name: 'capture_order_intent' }),
    s.entry('user', 'please'),
  );
  const duplicate = await s.tool('capture_order_intent', place);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.intent.id, firstCapture.data.intent.id);
  await s.append(s.entry('user', 'wait?'));
  code(await s.tool('capture_order_intent', place), 422, 'confirmation_missing');
  assert.equal((await s.list()).data.count, 1);
});

test('query parameter errors precede transcript sync and unknown book precedes missing speech', async (t) => {
  const app = await setup(t),
    s = await app.start();
  const base = { venue, utterance: 'bitcoin' };
  code(
    await s.tool('search_markets', { ...base, query: '  ' }, randomUUID(), 1),
    400,
    'invalid_parameters',
  );
  code(
    await s.tool('get_order_status', { ...base, order_id: '---' }, randomUUID(), 1),
    400,
    'invalid_parameters',
  );
  code(await s.tool('get_orderbook', { ...base, instrument: 'FAKE' }), 422, 'unknown_instrument');
  assert.equal((await s.list()).data.count, 0);
});

test('rejects spot order, cancel and status even with valid spoken evidence and a pre-upgrade replay', async (t) => {
  const app = await setup(t),
    s = await app.start();
  const spot = {
    ...place,
    venue: 'gemini_spot',
    side: 'buy',
    instrument: 'BTCUSD',
    quantity: 1,
    limit_price: 97455,
    utterance: 'buy one bitcoin at 97455 dollars',
  };
  await s.append(
    s.entry('user', spot.utterance),
    s.entry(
      'agent',
      'Confirming: buy 1 BTCUSD on Gemini spot at a limit of 97455 dollars. Say yes to confirm.',
    ),
    s.entry('user', 'yes'),
  );
  const cancel = {
    venue: 'gemini_spot',
    order_id: 'AB123',
    confirmed_by_user: true,
    utterance: 'cancel AB123',
  };
  for (const [path, parameters] of [
    ['/tools/capture_order_intent', spot],
    ['/tools/capture_cancel_intent', cancel],
    ['/tools/get_order_status', { venue: 'gemini_spot', utterance: 'status' }],
    ['/intents', { ...spot, intent: 'place_order' }],
    ['/intents', { ...cancel, intent: 'cancel_order' }],
  ]) {
    const envelope = {
      session_id: s.session_id,
      last_transcript_seq: 3,
      ...(path === '/intents' ? parameters : { parameters }),
    };
    const fresh = randomUUID();
    const send = (key) => app.request(path, envelope, s.session_token, key);
    code(await send(fresh), 400, 'invalid_parameters');
    code(await send(fresh), 400, 'invalid_parameters');
    const imported = randomUUID();
    app.repo.remember(s.session_id, imported, JSON.stringify([path, envelope]), [
      200,
      { simulated: true, ok: true },
    ]);
    code(await send(imported), 400, 'invalid_parameters');
  }
  code(
    await s.tool('get_order_status', { venue, side: 'sell', utterance: 'status' }),
    400,
    'invalid_parameters',
  );
  code(
    await s.post(
      '/intents',
      { ...place, side: 'buy', intent: 'place_order', last_transcript_seq: 3 },
      randomUUID(),
    ),
    400,
    'invalid_parameters',
  );
  assert.equal(app.repo.intents(s.session_id).length, 0);
});

test('legacy spot trades stay in SQLite and read-only spot queries remain visible', async (t) => {
  const app = await setup(t),
    s = await app.start();
  const legacy = {
    id: randomUUID(),
    session_id: s.session_id,
    created_at: new Date().toISOString(),
    intent: 'place_order',
    venue: 'gemini_spot',
    instrument: 'BTCUSD',
    side: 'buy',
    quantity: 1,
    limit_price: 97455,
    order_id: null,
    confirmed_by_user: true,
    utterance: 'buy bitcoin',
    status: 'captured',
  };
  app.repo.insert(legacy);
  app.repo.insert({
    ...legacy,
    id: randomUUID(),
    intent: 'cancel_order',
    side: null,
    quantity: null,
    limit_price: null,
    order_id: legacy.id,
  });
  app.repo.insert({
    ...legacy,
    id: randomUUID(),
    intent: 'order_status',
    side: null,
    quantity: null,
    limit_price: null,
    confirmed_by_user: false,
  });
  await s.append(s.entry('user', 'what is bitcoin trading at'));
  const market = await s.tool('get_orderbook', {
    venue: 'gemini_spot',
    instrument: 'BTCUSD',
    utterance: 'what is bitcoin trading at',
  });
  assert.equal(market.status, 200);
  assert.equal((await s.list()).data.count, 1);
  const status = await s.tool('get_order_status', {
    venue,
    order_id: legacy.id,
    utterance: 'status',
  });
  assert.equal(status.data.count, 0);
  code(
    await s.tool('capture_cancel_intent', {
      venue,
      order_id: legacy.id,
      utterance: 'cancel my order',
      confirmed_by_user: true,
    }),
    422,
    'order_id_not_user_supplied',
  );
  await s.append(
    s.entry('user', 'cancel AB123'),
    s.entry('agent', 'Cancel order AB123 on Gemini prediction. Say yes to confirm.'),
    s.entry('user', 'yes'),
  );
  code(
    await s.tool('capture_cancel_intent', {
      venue,
      order_id: 'AB123',
      instrument: 'BTCUSD',
      utterance: 'cancel AB123',
      confirmed_by_user: true,
    }),
    422,
    'unknown_instrument',
  );
  assert.equal(app.repo.intents(s.session_id).length, 5);
  assert.equal((await s.list()).data.count, 2);
});

test('running capture API accepts a verified sandbox contract and replays without rechecking its quote', async t => {
  const symbol = 'GEMI-EVENT-OUTCOME';
  const seen = [];
  const f = await setup(t, {
    legacyMarket: undefined,
    lookupInstrument: async instrument => { seen.push(instrument); return instrument === symbol; },
  });
  const s = await f.start();
  await s.append(s.entry('user', place.utterance), s.entry('agent', readback.replace(place.instrument, symbol)), s.entry('user', 'yes'));
  const params = { ...place, instrument: symbol };
  const key = randomUUID();
  const response = await s.tool('capture_order_intent', params, key);
  assert.equal(response.status, 201);
  assert.equal(response.data.intent.instrument, symbol);
  assert.deepEqual((await s.tool('capture_order_intent', params, key)).data, response.data);
  code(await s.tool('capture_order_intent', { ...params, instrument: 'BTCUSD' }), 422, 'unknown_instrument');
  assert.deepEqual(seen, [symbol, 'BTCUSD']);
});

import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ApiError, api, requests, validList, uuid4, requireRule } from './contracts.mjs';
import { SQLiteRepository } from './repository.mjs';
import { runTool, validateQueryParameters, visibleIntent } from './tools.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    requireRule(length <= 2_000_000, 'invalid_parameters');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new ApiError('invalid_parameters');
  }
}

async function sign(repo, { apiKey, agentId, branchId, upstream, clock }) {
  requireRule(apiKey && agentId, 'voice_not_configured');
  const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
  url.searchParams.set('agent_id', agentId);
  if (branchId) url.searchParams.set('branch_id', branchId);
  url.searchParams.set('include_conversation_id', 'true');
  let signed;
  try {
    const response = await upstream(url, {
      headers: { 'xi-api-key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new ApiError('elevenlabs_unavailable', {
      message: response.status === 404 ? 'ElevenLabs cannot find this agent with the configured key (HTTP 404).' :
        `ElevenLabs rejected the signed URL request (HTTP ${response.status}).`,
    });
    signed = (await response.json()).signed_url;
    if (new URL(signed).protocol !== 'wss:') throw new Error();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('elevenlabs_unavailable');
  }
  const now = clock(),
    expires = now + 3600000,
    signedExpires = now + 900000;
  const id = randomUUID(),
    token = randomBytes(32).toString('base64url');
  repo.create(id, hash(token), now, expires, signedExpires);
  return [
    201,
    {
      session_id: id,
      session_token: token,
      signed_url: signed,
      signed_url_expires_at: new Date(signedExpires).toISOString(),
      session_expires_at: new Date(expires).toISOString(),
    },
  ];
}

function append(repo, session, body, now) {
  const saved = repo.transcript(session.id);
  const previous = saved.length;
  for (const entry of body.entries) {
    requireRule(
      (entry.role === 'tool') === 'tool_name' in entry &&
        (entry.role === 'agent' || !('interrupted' in entry)),
      'invalid_parameters',
    );
    requireRule(entry.seq <= saved.length + 1, 'seq_gap', { expected_seq: saved.length + 1 });
    if (entry.seq <= saved.length)
      requireRule(isDeepStrictEqual(entry, saved[entry.seq - 1]), 'seq_conflict');
    else saved.push(entry);
  }
  for (const entry of saved.slice(previous)) repo.append(session.id, entry, now);
  const state = body.final ? 'ended' : 'active';
  repo.touch(session.id, now, state, body.conversation_id);
  return [
    200,
    {
      session_id: session.id,
      accepted: saved.length - previous,
      last_seq: saved.length,
      session_state: state,
    },
  ];
}

const orderPaths = new Set([
  '/intents',
  '/tools/capture_order_intent',
  '/tools/capture_cancel_intent',
  '/tools/get_order_status',
]);

function enforcePredictionScope(path, body) {
  if (!orderPaths.has(path)) return;
  const params = path === '/intents' ? body : body?.parameters;
  requireRule(
    params?.venue !== 'gemini_spot' && !['buy', 'sell'].includes(params?.side),
    'invalid_parameters',
  );
}

function handle(repo, session, path, method, body, key, now, market, legacyMarket) {
  requireRule(body?.session_id == null || body.session_id === session.id, 'unauthorized');
  requireRule(now < session.expires, 'session_not_found');
  const ended =
    session.state === 'ended' ||
    now >= session.last_seen + 600000 ||
    (session.state === 'created' && now >= session.signed_expires);
  if (ended && session.state !== 'ended') repo.touch(session.id, session.last_seen, 'ended');
  if (method === 'GET') {
    if ('limit' in body) body.limit = /^\d+$/.test(body.limit) ? Number(body.limit) : NaN;
    requireRule(validList(body), 'invalid_parameters');
    const intents = repo
      .intents(session.id)
      .map((row) => row.intent)
      .filter(visibleIntent)
      .filter(
        (i) =>
          (!body.intent || i.intent === body.intent) &&
          (!body.before || Date.parse(i.created_at) < Date.parse(body.before)),
      )
      .slice(0, body.limit ?? 50);
    repo.touch(session.id, now, ended ? 'ended' : session.state);
    return [200, { session_id: session.id, simulated: true, count: intents.length, intents }];
  }
  if (path === '/transcripts') {
    requireRule(!ended, 'session_ended');
    requireRule(requests[path](body), 'invalid_parameters');
    return append(repo, session, body, now);
  }

  const cacheable = uuid4.test(key);
  const replay = cacheable && repo.replay(session.id, key);
  const fingerprint = JSON.stringify([path, body]);
  if (replay) {
    requireRule(
      isDeepStrictEqual(JSON.parse(replay.fingerprint), [path, body]),
      'idempotency_key_reused',
    );
    // A matching cache entry can predate the prediction-only contract.
    enforcePredictionScope(path, body);
    if (!ended) repo.touch(session.id, now, session.state);
    return JSON.parse(replay.response);
  }
  let result;
  try {
    requireRule(!ended, 'session_ended');
    requireRule(cacheable && requests[path](body), 'invalid_parameters');
    enforcePredictionScope(path, body);
    validateQueryParameters(path, body.parameters);
    const transcript = repo.transcript(session.id);
    requireRule(transcript.length >= body.last_transcript_seq, 'transcript_not_synced', {
      expected_seq: transcript.length + 1,
    });
    const name =
      path === '/intents'
        ? body.intent === 'place_order'
          ? 'capture_order_intent'
          : 'capture_cancel_intent'
        : path.slice('/tools/'.length);
    result = runTool(
      repo,
      name,
      path === '/intents' ? body : body.parameters,
      session.id,
      transcript,
      now, market, legacyMarket,
    );
    repo.touch(session.id, now, session.state);
  } catch (err) {
    if (!(err instanceof ApiError) || err.body.error.code === 'transcript_not_synced') throw err;
    result = [err.status, err.body];
  }
  if (cacheable) repo.remember(session.id, key, fingerprint, result);
  return result;
}

export function createApi({ accountSummary, trading, repo, apiKey, agentId, branchId, lookupInstrument = async () => false, legacyMarket, upstream = fetch, clock = Date.now }) {
  return createServer(async (req, res) => {
    function reply([status, body]) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (accountSummary && url.pathname === '/internal/account-summary' && req.method === 'GET' &&
          req.headers.host === '127.0.0.1:' + req.socket.localPort && !req.headers.origin) {
        return reply([200, await accountSummary()]);
      }
      const path = url.pathname.slice(4);
      if (trading && path.startsWith('/trading/')) {
        const host = req.headers.host ?? '';
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$/.test(host) ||
            (req.headers.origin && req.headers.origin !== 'http://' + host && req.headers.origin !== 'https://' + host))
          return reply([403, {ok:false,message:'Local browser access required.'}]);
        if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
          return reply([415,{ok:false,message:'JSON required.'}]);
        try {
          const deviceCookie = /(?:^|;\s*)v2p_device=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
          const result = await trading({ path:path.slice('/trading/'.length), method:req.method,
            host, deviceCookie, setDeviceCookie: (value, seconds) => res.setHeader('Set-Cookie',
              'v2p_device=' + value + '; HttpOnly; SameSite=Strict; Path=/api/trading; Max-Age=' + seconds),
            token:/^Bearer ([^ ]+)$/i.exec(req.headers.authorization ?? '')?.[1],
            body:req.method === 'POST' ? await readBody(req) : {}, key:req.headers['idempotency-key'] });
          return reply([200,result]);
        } catch (err) {
          return reply([err.name === 'TradeError' ? err.status : 503, { ok:false,
            error:err.name === 'TradeError' ? err.code : 'SERVICE_UNAVAILABLE',
            message:err.name === 'TradeError' ? err.message : 'Trade service unavailable. Check order status before retrying an approval.' }]);
        }
      }
      if (!url.pathname.startsWith('/api/') || !Object.hasOwn(api.paths, path))
        return reply([404, {}]);
      if (!Object.hasOwn(api.paths[path], req.method.toLowerCase())) return reply([405, {}]);
      if (path === '/voice/signed-url') {
        requireRule(requests[path](await readBody(req)), 'invalid_parameters');
        return reply(await sign(repo, { apiKey, agentId, branchId, upstream, clock }));
      }
      if (!legacyMarket && ['/tools/search_markets', '/tools/get_orderbook'].includes(path))
        return reply([410, { ok: false, error: 'Use /api/public/market-tools for live sandbox reads.' }]);
      const token = /^Bearer ([^ ]+)$/i.exec(req.headers.authorization ?? '')?.[1];
      requireRule(token, 'unauthorized');
      const digest = hash(token);
      const scopedSession = repo.authenticate(digest);
      requireRule(scopedSession, 'unauthorized');
      const body =
        req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
      const key = req.headers['idempotency-key'];
      const params = path === '/intents' ? body : body.parameters;
      let market = false;
      const capture = path === '/intents' || path.startsWith('/tools/capture_');
      if (req.method === 'POST' && (legacyMarket || (capture && params?.venue === 'gemini_prediction')) &&
          typeof params?.instrument === 'string' && params.instrument && params.instrument.length <= 64 &&
          uuid4.test(key) && requests[path](body) && scopedSession.id === body.session_id &&
          !repo.replay(scopedSession.id, key)) {
        // A recorded order can be cancelled after its market closes. Fresh captures require a live contract.
        const knownTarget = params.order_id && repo.intents(scopedSession.id).some(row => row.intent.id === params.order_id);
        if (!knownTarget) market = await lookupInstrument(params.instrument, params.venue);
      }
      reply(
        repo.transaction(() =>
          handle(
            repo,
            repo.authenticate(digest),
            path,
            req.method,
            body,
            req.headers['idempotency-key'],
            clock(), market, legacyMarket,
          ),
        ),
      );
    } catch (err) {
      if (err instanceof ApiError) reply([err.status, err.body]);
      else {
        console.error('Capture service error', err.name);
        reply([500, new ApiError('backend_unavailable').body]);
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = new SQLiteRepository(process.env.SQLITE_PATH || 'data/capture.sqlite');
  createApi({
    repo,
    apiKey: process.env.ELEVENLABS_API_KEY,
    agentId: process.env.ELEVENLABS_AGENT_ID,
    branchId: process.env.ELEVENLABS_BRANCH_ID,
  }).listen(8787, '127.0.0.1', () => console.info('Capture API listening on 127.0.0.1:8787'));
}

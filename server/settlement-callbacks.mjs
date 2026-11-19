import { createHash } from 'node:crypto';

// One sandbox account and a destination set by the operator of this local launcher.
// Changing the destination invalidates the old consent.
function settings() {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from, SETTLEMENT_CALLBACK_TO: to } = process.env;
  const phone = /^\+[1-9]\d{6,14}$/;
  if (!/^AC[a-f\d]{32}$/i.test(sid ?? '') || !token || !phone.test(from ?? '') || !phone.test(to ?? '')) return null;
  return { sid, token, from, to, binding: createHash('sha256').update(sid + ':' + to).digest('hex') };
}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS callback_consent (id INTEGER PRIMARY KEY, binding TEXT, since INTEGER);
    CREATE TABLE IF NOT EXISTS settlement_calls (event TEXT PRIMARY KEY, status TEXT NOT NULL);`);
}
export function configureSettlementCallbacks(repo, method, body) {
  const { db } = repo;
  initialize(db);
  const cfg = settings();
  if (method === 'POST') {
    if (typeof body?.enabled !== 'boolean' || Object.keys(body).length !== 1) return {ok:false, message:'Choose whether to receive settlement calls.'};
    if (!body.enabled) db.prepare('DELETE FROM callback_consent').run();
    else if (!cfg) return {ok:false,message:'Configure the callback phone service first.'};
    else db.prepare('INSERT INTO callback_consent VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET binding=excluded.binding, since=excluded.since WHERE binding<>excluded.binding').run(cfg.binding, Date.now());
  }
  const enabled = Boolean(cfg && db.prepare('SELECT 1 FROM callback_consent WHERE id=1 AND binding=?').get(cfg.binding));
  return { ok:true, configured:!!cfg, enabled, ending:cfg?.to.slice(-4) ?? null };
}
const escapeXml = text => String(text).replace(/[<>&"']/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'})[ch]);

export async function pollSettlementCallbacks(repo, readSettlements, send = fetch) {
  const cfg = settings();
  if (!cfg) return;
  const { db } = repo;
  initialize(db);
  const consent = () => db.prepare('SELECT since FROM callback_consent WHERE id=1 AND binding=?').get(cfg.binding)?.since;
  const since = consent();
  if (!since) return;
  const rows = await readSettlements();
  if (!Array.isArray(rows) || consent() !== since) return;
  const fresh = [];
  repo.transaction(() => {
    for (const row of rows) {
      const time = Date.parse(row.settledAt);
      if (!row.instrumentSymbol || !Number.isFinite(time) || time <= since || !['yes','no'].includes(String(row.outcome).toLowerCase())) continue;
      const key = JSON.stringify([cfg.binding,row.instrumentSymbol,row.outcome,row.settledAt]);
      if (db.prepare("INSERT OR IGNORE INTO settlement_calls VALUES (?,'sending')").run(key).changes) fresh.push({key,row});
    }
  });
  if (!fresh.length) return;
  // One short call per batch. Reserve before sending to prevent double dialing on a restart.
  const {row} = fresh[0];
  const payout = Number(row.payout);
  const hasPayout = row.payout != null && row.payout !== '' && Number.isFinite(payout) && payout >= 0;
  const summary = fresh.length === 1
    ? `Your ${String(row.contractMetadata?.eventName || 'prediction').slice(0,160)} sandbox position has settled.${hasPayout ? ' Payout: ' + payout.toFixed(2) + ' dollars.' : ''}`
    : `${fresh.length} sandbox positions have settled. Open Account for details.`;
  let state = 'delivery_unknown';
  try {
    const response = await send(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Calls.json`, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Basic '+Buffer.from(cfg.sid+':'+cfg.token).toString('base64')},
      body:new URLSearchParams({To:cfg.to,From:cfg.from,Twiml:`<Response><Say>${escapeXml(summary)}</Say><Hangup/></Response>`}),
    });
    state = response.ok ? 'queued' : 'rejected';
  } finally {
    repo.transaction(() => { for (const {key} of fresh) db.prepare('UPDATE settlement_calls SET status=? WHERE event=?').run(state,key); });
  }
}

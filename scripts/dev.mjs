// One loopback listener for the UI, server routes and session-scoped capture API.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
for (const file of ['.env', process.env.SERVER_ENV_FILE ?? '../UBC-Hackathon/.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const { createApi } = await import('../server/api.mjs');
const { SQLiteRepository } = await import('../server/repository.mjs');
const { getEvent, findContract } = await import('../src/server/v2p/gemini.ts');
let repo;
try { repo = new SQLiteRepository(process.env.SQLITE_PATH || 'data/capture.sqlite'); }
catch { console.error('Voice capture unavailable: SQLite storage could not be opened.'); }
const { browserTrading } = await import('../server/browser-trading.mjs');
const capture = repo ? createApi({
  trading: browserTrading(repo), repo, apiKey: process.env.ELEVENLABS_API_KEY, agentId: process.env.ELEVENLABS_AGENT_ID,
  async lookupInstrument(symbol) {
    const match = /^GEMI-([A-Z0-9_.-]+)-[A-Z0-9_.]+$/i.exec(symbol);
    if (!match) return false;
    const { event, error } = await getEvent(match[1]);
    if (error) throw new Error('Prediction contract lookup unavailable');
    const contract = findContract(event, symbol);
    if (event?.ticker !== match[1] || contract?.status !== 'active' || contract.marketState !== 'open') return false;
    return { title: event.title, label: contract.label };
  },
}) : (await import('node:http')).createServer((_req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: { message: 'Voice capture storage unavailable.' } }));
});
capture.listen(0, '127.0.0.1');
await once(capture, 'listening');
const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, LOCAL_BROWSER_LEDGER: "sqlite", CAPTURE_PORT: String(capture.address().port) }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => vite.kill(signal));
vite.on('exit', code => { capture.closeAllConnections(); capture.close(); repo?.close(); process.exitCode = code ?? 0; });

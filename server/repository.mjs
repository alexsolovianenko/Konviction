import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The service depends on these synchronous repository operations. Transactions group
// the evidence check, intent write, confirmation binding and replay response.
export class SQLiteRepository {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, state TEXT,
        last_seen INTEGER, expires INTEGER, signed_expires INTEGER, conversation_id TEXT);
      CREATE TABLE IF NOT EXISTS transcript(session TEXT, seq INTEGER, entry TEXT, PRIMARY KEY(session, seq));
      CREATE TABLE IF NOT EXISTS intents(session TEXT, confirmation INTEGER, record TEXT, UNIQUE(session,confirmation));
      CREATE INDEX IF NOT EXISTS session_intents ON intents(session);
      CREATE TABLE IF NOT EXISTS replays(session TEXT, key TEXT, fingerprint TEXT, response TEXT, PRIMARY KEY(session,key));`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  create(id, hash, now, expires, signedExpires) {
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,'created',?,?,?,NULL)")
      .run(id, hash, now, expires, signedExpires);
  }
  authenticate(hash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash);
  }
  touch(id, now, state, conversation) {
    this.db
      .prepare(
        'UPDATE sessions SET last_seen=?,state=?,conversation_id=coalesce(?,conversation_id) WHERE id=?',
      )
      .run(now, state, conversation ?? null, id);
  }
  transcript(id) {
    return this.db
      .prepare('SELECT entry FROM transcript WHERE session=? ORDER BY seq')
      .all(id)
      .map((row) => JSON.parse(row.entry));
  }
  append(id, entry) {
    this.db
      .prepare('INSERT INTO transcript VALUES (?,?,?)')
      .run(id, entry.seq, JSON.stringify(entry));
  }
  intents(id) {
    return this.db
      .prepare('SELECT confirmation,record FROM intents WHERE session=? ORDER BY rowid DESC')
      .all(id)
      .map((row) => ({ seq: row.confirmation, intent: JSON.parse(row.record) }));
  }
  insert(intent, seq = null) {
    this.db
      .prepare('INSERT INTO intents VALUES (?,?,?)')
      .run(intent.session_id, seq, JSON.stringify(intent));
  }
  replay(id, key) {
    return this.db.prepare('SELECT * FROM replays WHERE session=? AND key=?').get(id, key);
  }
  remember(id, key, fingerprint, result) {
    this.db
      .prepare('INSERT INTO replays VALUES (?,?,?,?)')
      .run(id, key, fingerprint, JSON.stringify(result));
  }
  close() {
    this.db.close();
  }
}

import { createHmac, randomInt, randomUUID } from "node:crypto";

export class PhoneStore {
  constructor(repo, config) {
    this.repo = repo;
    this.db = repo.db;
    this.config = config;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phone_pairing (
        owner TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phone_calls (
        sid TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, turn TEXT,
        state TEXT NOT NULL, previous TEXT, fingerprint TEXT, response TEXT, started INTEGER
      );
    `);
  }
  digest(...values) {
    return createHmac("sha256", this.config.token).update(JSON.stringify(values)).digest("hex");
  }
  get owner() {
    return this.digest("owner", this.config.account, this.config.from, this.config.to);
  }
  issueCode() {
    const code = String(randomInt(100000000)).padStart(8, "0");
    this.db
      .prepare("INSERT OR REPLACE INTO phone_pairing VALUES (?,?,?,3)")
      .run(this.owner, this.digest("pair", this.owner, code), Date.now() + 300000);
    return code;
  }
  redeem(code) {
    return this.repo.transaction(() => {
      const consumed = this.db
        .prepare(
          "DELETE FROM phone_pairing WHERE owner=? AND digest=? AND expires>? AND attempts>0",
        )
        .run(this.owner, this.digest("pair", this.owner, code), Date.now()).changes;
      if (!consumed)
        this.db
          .prepare("UPDATE phone_pairing SET attempts=MAX(0,attempts-1) WHERE owner=?")
          .run(this.owner);
      return Boolean(consumed);
    });
  }
  read(sid) {
    return this.db
      .prepare("SELECT * FROM phone_calls WHERE sid=? AND owner=?")
      .get(sid, this.owner);
  }
  start(sid, render) {
    return this.repo.transaction(() => {
      const turn = randomUUID();
      const response = render(turn);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO phone_calls(sid,owner,expires,turn,state,response) VALUES (?,?,?,?,?,?)",
        )
        .run(
          sid,
          this.owner,
          Date.now() + 900000,
          turn,
          JSON.stringify({ step: "pair" }),
          response,
        );
      const row = this.read(sid);
      return row?.expires > Date.now() && !row.previous ? row.response : null;
    });
  }
  stop(sid) {
    // A terminal event can arrive before an initial webhook retry. Keep a tombstone.
    this.db
      .prepare(
        `INSERT INTO phone_calls(sid,owner,expires,state) VALUES (?,?,0,'{}')
      ON CONFLICT(sid) DO UPDATE SET expires=0,turn=NULL,state='{}',response=NULL`,
      )
      .run(sid, this.owner);
  }
  take(sid, turn, fingerprint) {
    return this.repo.transaction(() => {
      const row = this.read(sid);
      if (!row || row.expires <= Date.now()) return {};
      if (row.previous === turn && row.fingerprint === fingerprint) return { replay: true };
      if (row.turn !== turn) return {};
      this.db
        .prepare(
          "UPDATE phone_calls SET turn=NULL,previous=?,fingerprint=?,response=NULL,started=? WHERE sid=?",
        )
        .run(turn, fingerprint, Date.now(), sid);
      return { state: JSON.parse(row.state) };
    });
  }
  finish(sid, previous, state, turn, response) {
    return this.db
      .prepare(
        "UPDATE phone_calls SET state=?,turn=?,response=? WHERE sid=? AND previous=? AND expires>?",
      )
      .run(JSON.stringify(state), turn, response, sid, previous, Date.now()).changes;
  }
}

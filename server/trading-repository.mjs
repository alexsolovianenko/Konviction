import { randomUUID } from "node:crypto";

export class TradeError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "TradeError";
    this.code = code;
    this.status = status;
  }
}
export class TradingRepository {
  constructor(repository) {
    this.repository = repository;
    this.db = repository.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_proposals (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        terms TEXT NOT NULL, status TEXT NOT NULL, reserved_cents INTEGER NOT NULL DEFAULT 0,
        approval_day TEXT, result TEXT, UNIQUE(owner, request_id)
      );
      CREATE INDEX IF NOT EXISTS browser_risk ON browser_proposals(status,approval_day);
      CREATE TABLE IF NOT EXISTS browser_pin_guard (id INTEGER PRIMARY KEY, failures INTEGER NOT NULL, locked_until INTEGER NOT NULL);
      INSERT OR IGNORE INTO browser_pin_guard VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS browser_trade_audit (proposal TEXT, at TEXT, kind TEXT, detail TEXT);
    `);
  }
  checkPin(matches, now = Date.now()) {
    const accepted = this.repository.transaction(() => {
      const row = this.db.prepare("SELECT * FROM browser_pin_guard WHERE id=1").get();
      if (now < row.locked_until)
        throw new TradeError("LOCKED", "Too many attempts. Try again in 15 minutes.", 429);
      const failures = matches ? 0 : row.failures + 1;
      this.db
        .prepare("UPDATE browser_pin_guard SET failures=?,locked_until=? WHERE id=1")
        .run(failures >= 3 ? 0 : failures, failures >= 3 ? now + 900000 : 0);
      return matches;
    });
    if (!accepted) throw new TradeError("WRONG_PIN", "Incorrect PIN.", 403);
  }
  replay(owner, key, fingerprint) {
    const row = this.db
      .prepare("SELECT * FROM browser_proposals WHERE owner=? AND request_id=?")
      .get(owner, key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new TradeError("KEY_REUSED", "Request identifier already used with different terms.");
    if (row.status !== "PROPOSED" || Date.parse(JSON.parse(row.terms).expires_at) <= Date.now())
      throw new TradeError("INACTIVE", "This proposal is no longer awaiting approval.");
    return { ...JSON.parse(row.terms), proposal_id: row.id };
  }
  reservedToday(day) {
    return this.db
      .prepare(
        "SELECT COALESCE(SUM(reserved_cents),0) AS total FROM browser_proposals WHERE approval_day=? OR status IN ('EXECUTING','UNKNOWN')",
      )
      .get(day).total;
  }
  propose(owner, key, fingerprint, terms, maxDaily, onInsert) {
    return this.repository.transaction(() => {
      const replay = this.replay(owner, key, fingerprint);
      if (replay) return replay;
      const cost = Math.round((terms.notional_usd + terms.est_fee_usd) * 100);
      if (
        this.reservedToday(new Date().toISOString().slice(0, 10)) + cost >
        Math.round(maxDaily * 100)
      )
        throw new TradeError(
          "CAP_EXCEEDED",
          "This proposal exceeds the remaining daily sandbox limit.",
        );
      const id = randomUUID();
      this.db
        .prepare(
          "UPDATE browser_proposals SET status='SUPERSEDED' WHERE owner=? AND status='PROPOSED'",
        )
        .run(owner);
      this.db
        .prepare(
          "INSERT INTO browser_proposals(id,owner,request_id,fingerprint,terms,status) VALUES (?,?,?,?,?,'PROPOSED')",
        )
        .run(id, owner, key, fingerprint, JSON.stringify(terms));
      onInsert?.(id);
      return { ...terms, proposal_id: id };
    });
  }
  claim(owner, id, limits, authorize) {
    return this.repository.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM browser_proposals WHERE owner=? AND id=?")
        .get(owner, id);
      if (!row)
        throw new TradeError(
          "UNKNOWN_PROPOSAL",
          "Proposal unavailable for this voice session.",
          404,
        );
      authorize?.();
      if (row.result) return { result: JSON.parse(row.result) };
      if (row.status === "EXECUTING")
        throw new TradeError(
          "IN_PROGRESS",
          "Approval already received. Check order status before taking further action.",
        );
      const terms = JSON.parse(row.terms);
      if (row.status !== "PROPOSED" || Date.parse(terms.expires_at) <= Date.now())
        throw new TradeError(
          "INACTIVE",
          "This proposal was replaced or expired. Request a fresh quote.",
        );
      const day = new Date().toISOString().slice(0, 10);
      const cost = Math.round((terms.notional_usd + terms.est_fee_usd) * 100);
      if (
        terms.quantity > limits.maxQuantity ||
        terms.limit_price > limits.maxLimitPrice ||
        cost > Math.round(limits.maxOrderUsd * 100) ||
        this.reservedToday(day) + cost > Math.round(limits.maxDailyUsd * 100)
      )
        throw new TradeError(
          "CAP_EXCEEDED",
          "The current order or daily sandbox limit would be exceeded.",
        );
      this.db
        .prepare(
          "UPDATE browser_proposals SET status='EXECUTING', approval_day=?, reserved_cents=? WHERE id=?",
        )
        .run(day, cost, id);
      return { terms: { ...terms, id, code: id } };
    });
  }
  audit(id, kind, detail) {
    this.db
      .prepare("INSERT INTO browser_trade_audit VALUES (?,?,?,?)")
      .run(id, new Date().toISOString(), kind, JSON.stringify(detail));
  }
  finish(id, result) {
    const unknown = result.outcome_summary === "PENDING_UNKNOWN";
    const release = !unknown && (!result.ok || result.outcome_summary === "NOT_FILLED");
    this.db
      .prepare(
        "UPDATE browser_proposals SET status=?,result=?,reserved_cents=CASE WHEN ? THEN 0 ELSE reserved_cents END WHERE id=? AND status='EXECUTING'",
      )
      .run(unknown ? "UNKNOWN" : "DONE", JSON.stringify(result), release ? 1 : 0, id);
  }
}

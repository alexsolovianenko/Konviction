import { randomUUID } from "node:crypto";

export class TradeError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "TradeError";
    this.code = code;
    this.status = status;
  }
}
function requirePendingProposal(row, terms) {
  if (row.status === "SUPERSEDED")
    throw new TradeError("SUPERSEDED", "A newer order replaced this one.");
  if (row.status !== "PROPOSED")
    throw new TradeError("INACTIVE", "This proposal is no longer awaiting confirmation.");
  if (!(Date.parse(terms.expires_at) > Date.now()))
    throw new TradeError("EXPIRED", "Quote expired. Requote?");
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
      CREATE TABLE IF NOT EXISTS browser_trade_audit (proposal TEXT, at TEXT, kind TEXT, detail TEXT);
    `);
  }
  replay(owner, key, fingerprint) {
    const row = this.db
      .prepare("SELECT * FROM browser_proposals WHERE owner=? AND request_id=?")
      .get(owner, key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new TradeError("KEY_REUSED", "Request identifier already used with different terms.");
    const terms = JSON.parse(row.terms);
    requirePendingProposal(row, terms);
    return { ...terms, proposal_id: row.id };
  }
  openOrders() {
    return this.db.prepare(`
      SELECT id AS intent_id, json_extract(result, '$.order_id') AS gemini_order_id,
        json_extract(terms, '$.instrument_symbol') AS instrument_symbol, json_extract(terms, '$.side') AS side,
        json_extract(terms, '$.budget_usd') AS budget_usd, json_extract(terms, '$.quantity') AS quantity, json_extract(terms, '$.limit_price') AS limit_price
      FROM browser_proposals WHERE status='OPEN'
    `).all();
  }
  finalizeOpenOrder(id, result, spentCents) {
    this.db.prepare(`UPDATE browser_proposals SET status='DONE', result=?, reserved_cents=?, approval_day=?
      WHERE id=? AND status='OPEN'`).run(JSON.stringify(result), spentCents, new Date().toISOString().slice(0, 10), id);
  }
  propose(owner, key, fingerprint, terms, onInsert) {
    return this.repository.transaction(() => {
      const replay = this.replay(owner, key, fingerprint);
      if (replay) return replay;
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
  dismiss(owner, id) {
    this.db.prepare("UPDATE browser_proposals SET status='SUPERSEDED' WHERE owner=? AND id=? AND status='PROPOSED'").run(owner, id);
  }
  claim(owner, id, authorize) {
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
      requirePendingProposal(row, terms);
      const day = new Date().toISOString().slice(0, 10);
      const cost = terms.side === "sell" ? 0 : Math.round((terms.notional_usd + terms.est_fee_usd) * 100);
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
    if (result.order_mode === "market" && !unknown) {
      const charged = result.side === "sell" ? 0 : Math.round((result.filled_notional_usd + result.est_fee_usd) * 100);
      this.db.prepare("UPDATE browser_proposals SET status='DONE',result=?,reserved_cents=CASE WHEN json_extract(terms,'$.side')='sell' THEN 0 ELSE ? END WHERE id=? AND status='EXECUTING'")
        .run(JSON.stringify(result), charged, id);
      return;
    }
    const release = !unknown && (!result.ok || result.outcome_summary === "NOT_FILLED");
    let retainedFraction = release ? 0 : 1;
    if (result.outcome_summary === "PARTIAL" && result.remainder_buy) {
      const filled = result.filled_quantity;
      retainedFraction = filled / (filled + result.remainder_buy.quantity);
    }
    this.db
      .prepare("UPDATE browser_proposals SET status=?,result=?,reserved_cents=ceil(reserved_cents * ?) WHERE id=? AND status='EXECUTING'")
      .run(unknown ? "UNKNOWN" : result.outcome_summary === "OPEN" ? "OPEN" : "DONE", JSON.stringify(result), retainedFraction, id);
  }
}

import { createHash, randomBytes } from "node:crypto";
import { TradeError } from "./trading-repository.mjs";

export const deviceLifetimeSeconds = 8 * 60 * 60;
const hash = value => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export class TrustedDevices {
  constructor(repo) {
    this.repo = repo;
    this.db = repo.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_pairing_codes (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_devices (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_voice_approvals (
        proposal TEXT PRIMARY KEY, device TEXT NOT NULL, min_seq INTEGER NOT NULL,
        owner TEXT NOT NULL, confirmation_seq INTEGER, UNIQUE(owner, confirmation_seq)
      );
    `);
  }

  issueCode() {
    const code = secret();
    this.db.prepare("DELETE FROM browser_pairing_codes WHERE expires<=?").run(Date.now());
    this.db.prepare("INSERT INTO browser_pairing_codes VALUES (?,?)").run(hash(code), Date.now() + 5 * 60000);
    return code;
  }

  redeem(code) {
    if (!valid(code) || !this.db.prepare("DELETE FROM browser_pairing_codes WHERE digest=? AND expires>? RETURNING digest")
      .get(hash(code), Date.now())) throw new TradeError("PAIRING_EXPIRED", "Pairing link expired or already used.", 403);
  }

  grant(host) {
    const token = secret();
    this.db.prepare("DELETE FROM browser_devices WHERE expires<=?").run(Date.now());
    this.db.prepare("INSERT INTO browser_devices VALUES (?,?)").run(hash(host + "/" + token), Date.now() + deviceLifetimeSeconds * 1000);
    return token;
  }

  identify(host, token) {
    if (!valid(token)) return null;
    const digest = hash(host + "/" + token);
    return this.db.prepare("SELECT digest FROM browser_devices WHERE digest=? AND expires>?").get(digest, Date.now())?.digest;
  }

  bind(id, owner, device) {
    const seq = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM transcript WHERE session=?").get(owner).seq;
    this.db.prepare("INSERT INTO browser_voice_approvals(proposal,device,min_seq,owner) VALUES (?,?,?,?)").run(id, device, seq, owner);
  }

  confirm(id, owner, device, seq) {
    const row = this.db.prepare(`SELECT a.*, p.terms FROM browser_voice_approvals a JOIN browser_proposals p ON p.id=a.proposal
      WHERE a.proposal=? AND a.owner=? AND a.device=?`).get(id, owner, device);
    if (!row) throw new TradeError("DEVICE_REQUIRED", "Prepare this order on your paired device.", 403);
    if (row.confirmation_seq === seq) return;
    const entries = this.repo.transcript(owner).filter(entry => entry.role !== "tool");
    const answer = entries.at(-1);
    const readback = entries.at(-2);
    const terms = JSON.parse(row.terms);
    const normalize = s => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    const received = this.repo.receivedAt(owner, seq);
    if (row.confirmation_seq !== null || !received || Date.now() - received > 30000 || received > Date.now() ||
        answer?.role !== "user" || answer.seq !== seq || !/^(?:confirm|yes|yes[, ]+confirm)[.!]?$/i.test(answer.text.trim()) ||
        readback?.role !== "agent" || readback.seq <= row.min_seq || readback.interrupted ||
        normalize(readback.text) !== normalize(terms.voice_readback))
      throw new TradeError("CONFIRMATION_REQUIRED", "Listen to the complete order and say confirm.", 409);
    const updated = this.db.prepare("UPDATE OR IGNORE browser_voice_approvals SET confirmation_seq=? WHERE proposal=? AND confirmation_seq IS NULL").run(seq, id);
    if (updated.changes !== 1) throw new TradeError("CONFIRMATION_USED", "That confirmation has already been used.");
  }
}

// Browser voice session (adapted from alex's src/session.ts).
// Alex's version synced transcripts and capture-only intents to a local Node + SQLite server. On the
// Lovable/Cloudflare deployment the transcript stays in browser memory, credentials come from
// POST /api/public/browser-trading/session, and the capture-only client tools answer "not available"
// so the existing ElevenLabs agent never hangs waiting for them.
import { tradingRequest } from './browserTrading';

export type Entry = {
  seq: number;
  timestamp: string;
  role: 'user' | 'agent' | 'tool';
  text: string;
  interrupted?: boolean;
  tool_name?: string;
};
export type Intent = {
  id: string;
  created_at: string;
  intent: string;
  venue: string;
  instrument: string;
  side: string | null;
  quantity: number | null;
  limit_price: number | null;
  order_id: string | null;
  utterance: string;
};
export type Credentials = { session_id: string; session_token: string; signed_url: string };

const CAPTURE_TOOLS = ['capture_order_intent', 'capture_cancel_intent', 'get_order_status'] as const;
const captureUnavailable = JSON.stringify({
  ok: false,
  error: {
    code: 'not_available',
    message: 'Saving intents is not available here.',
    agent_hint:
      'Say saving intents is not available here. For a sandbox buy use prepare_sandbox_buy; the user approves it on screen. Do not say anything was saved or placed.',
  },
});

export async function startCredentials(): Promise<Credentials> {
  const result = await tradingRequest('session', {});
  if (!result.ok || typeof result.signed_url !== 'string' || typeof result.session_token !== 'string')
    throw new Error(result.message || 'Voice service unavailable');
  return { session_id: result.session_id, session_token: result.session_token, signed_url: result.signed_url };
}

export class Session {
  readonly entries: Entry[] = [];
  captured: Intent[] = [];
  conversationId?: string;
  // Kept for alex's voice.ts: resolves to the sequence including a user turn awaiting playback evidence.
  pendingEvidence: Promise<number> | undefined;
  private closed = false;
  constructor(
    readonly credentials: Credentials,
    private changed: (entries: Entry[]) => void,
    _intents: (intents: Intent[]) => void,
    _report: (message: string) => void,
  ) {}

  invalidateEvidence() {
    /* No server-side capture evidence on this deployment. */
  }
  append(entry: Omit<Entry, 'seq' | 'timestamp'>) {
    if (this.closed) return;
    this.entries.push({ ...entry, seq: this.entries.length + 1, timestamp: new Date().toISOString() });
    this.changed([...this.entries]);
  }
  sync() {
    /* Transcript is kept in the browser only. */
  }
  readonly tools = Object.fromEntries(
    CAPTURE_TOOLS.map((name) => [
      name,
      async () => {
        this.append({ role: 'tool', tool_name: name, text: captureUnavailable });
        return captureUnavailable;
      },
    ]),
  );
  async close() {
    if (this.closed) return;
    this.closed = true;
    // Revoke the server session so it can no longer approve anything.
    await tradingRequest('end', {}, this.credentials.session_token, { keepalive: true });
  }
}

import toolContract from '../contracts/tools.json';

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
const unavailable = {
  ok: false,
  simulated: true,
  error: {
    code: 'backend_unavailable',
    message: 'The capture service did not respond.',
    agent_hint:
      'Say you could not reach the service and ask the user to try again. Do not say anything was prepared.',
  },
};

export async function startCredentials(): Promise<Credentials> {
  const response = await fetch('/api/voice/signed-url', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error((await response.json()).error?.message || 'Voice service unavailable');
  return response.json();
}

export class Session {
  readonly entries: Entry[] = [];
  captured: Intent[] = [];
  conversationId?: string;
  private synced = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    readonly credentials: Credentials,
    private changed: (entries: Entry[]) => void,
    private intents: (intents: Intent[]) => void,
    private report: (message: string) => void,
  ) {}

  private schedule<T>(fn: () => Promise<T>) {
    const work = this.queue.then(fn);
    this.queue = work.catch(() => {});
    return work;
  }
  private async request(path: string, body?: unknown, key?: string, keepalive = false) {
    const response = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + this.credentials.session_token,
        'Content-Type': 'application/json',
        ...(key && { 'Idempotency-Key': key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
      signal: AbortSignal.timeout(3500),
    });
    return response.json();
  }
  private record(entry: Omit<Entry, 'seq' | 'timestamp'>) {
    this.entries.push({
      ...entry,
      seq: this.entries.length + 1,
      timestamp: new Date().toISOString(),
    });
    this.changed([...this.entries]);
  }
  append(entry: Omit<Entry, 'seq' | 'timestamp'>) {
    if (this.closed) return;
    this.record(entry);
    this.sync();
  }
  sync() {
    const end = this.entries.length;
    void this.schedule(() => this.flush(end)).catch(() => this.report('Transcript sync delayed.'));
  }
  private async flush(end: number, final = false) {
    do {
      const entries = this.entries.slice(this.synced, Math.min(end, this.synced + 50));
      const last = this.synced + entries.length;
      const batch = {
        session_id: this.credentials.session_id,
        conversation_id: this.conversationId,
        entries,
        final: final && last === end,
      };
      const keepalive = batch.final && new Blob([JSON.stringify(batch)]).size < 64000;
      const result = await this.request('/transcripts', batch, undefined, keepalive);
      if (result.error || result.last_seq < last) throw new Error('Transcript sync failed.');
      this.synced = Math.max(this.synced, last);
    } while (this.synced < end);
  }
  private async refresh() {
    const result = await this.request('/intents?session_id=' + this.credentials.session_id);
    if (!Array.isArray(result.intents)) throw new Error();
    this.captured = result.intents;
    this.intents(this.captured);
  }
  readonly tools = Object.fromEntries(
    toolContract.tools.map((tool) => [
      tool.name,
      (parameters: Record<string, unknown>) => {
        if (this.closed) return Promise.resolve(JSON.stringify(unavailable));
        const end = this.entries.length;
        const key = crypto.randomUUID();
        const optional = Object.keys(tool.parameters.properties).filter(
          (k) => !tool.parameters.required.includes(k),
        );
        const body = {
          parameters: { ...Object.fromEntries(optional.map((k) => [k, null])), ...parameters },
          session_id: this.credentials.session_id,
          last_transcript_seq: end,
        };
        return this.schedule(async () => {
          let result = unavailable;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await this.flush(end);
              result = await this.request('/tools/' + tool.name, body, key);
              if (result.error?.code !== 'transcript_not_synced') break;
              const expected = (result.error as { expected_seq?: number }).expected_seq;
              if (expected && expected <= end) this.synced = expected - 1;
            } catch {
              result = unavailable;
            }
          }
          const text = JSON.stringify(result);
          this.record({ role: 'tool', tool_name: tool.name, text });
          try {
            await this.flush(this.entries.length);
          } catch {
            this.report('Transcript sync delayed.');
          }
          if (result.ok) {
            try {
              await this.refresh();
            } catch {
              this.report('Could not refresh captured intents.');
            }
          }
          return text;
        });
      },
    ]),
  );
  close() {
    this.closed = true;
    return this.schedule(async () => {
      try {
        await this.flush(this.entries.length, true);
      } catch {
        await this.flush(this.entries.length, true);
      }
    });
  }
}

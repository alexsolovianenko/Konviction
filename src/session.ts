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
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.signed_url || !result.session_token || !result.session_id)
    throw new Error(result?.error?.message || 'Voice service unavailable. Start voice to try again.');
  return result;
}

export class Session {
  readonly entries: Entry[] = [];
  captured: Intent[] = [];
  conversationId?: string;
  // Resolves to the sequence including a user turn awaiting late playback evidence.
  pendingEvidence: Promise<number> | undefined;
  private synced = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private evidenceValidity = new AbortController();
  invalidateEvidence() {
    this.evidenceValidity.abort();
  }
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
  private async request(
    path: string,
    body?: unknown,
    key?: string,
    keepalive = false,
    deadline?: AbortSignal,
  ) {
    const response = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + this.credentials.session_token,
        'Content-Type': 'application/json',
        ...(key && { 'Idempotency-Key': key }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      keepalive,
      signal: deadline
        ? AbortSignal.any([deadline, AbortSignal.timeout(3500)])
        : AbortSignal.timeout(3500),
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
  private async flush(end: number, final = false, deadline?: AbortSignal) {
    do {
      deadline?.throwIfAborted();
      const entries = this.entries.slice(this.synced, Math.min(end, this.synced + 50));
      const last = this.synced + entries.length;
      const batch = {
        session_id: this.credentials.session_id,
        conversation_id: this.conversationId,
        entries,
        final: final && last === end,
      };
      const keepalive = batch.final && new Blob([JSON.stringify(batch)]).size < 64000;
      const result = await this.request('/transcripts', batch, undefined, keepalive, deadline);
      if (result.error || result.last_seq < last) throw new Error('Transcript sync failed.');
      this.synced = Math.max(this.synced, last);
    } while (this.synced < end);
  }
  async confirmationSequence() {
    const evidence = this.pendingEvidence ?? this.entries.length;
    return this.schedule(async () => {
      const end = await evidence;
      const last = this.entries[end - 1];
      if (this.closed || !last || last.role !== 'user') throw new Error('Confirmation required.');
      await this.flush(end, false, this.evidenceValidity.signal);
      if (this.closed || this.entries.length !== end) throw new Error('Confirmation changed.');
      return end;
    });
  }
  private async refresh() {
    const result = await this.request('/intents?session_id=' + this.credentials.session_id);
    if (!Array.isArray(result.intents)) throw new Error();
    this.captured = result.intents;
    this.intents(this.captured);
  }
  readonly tools = Object.fromEntries(
    toolContract.tools.filter(tool =>
      ['capture_order_intent', 'capture_cancel_intent', 'get_order_status'].includes(tool.name),
    ).map((tool) => [
      tool.name,
      (parameters: Record<string, unknown>) => {
        if (this.closed) return Promise.resolve(JSON.stringify(unavailable));
        const evidence = this.pendingEvidence ?? this.entries.length;
        const key = crypto.randomUUID();
        const optional = Object.keys(tool.parameters.properties).filter(
          (k) => !tool.parameters.required.includes(k),
        );
        const deadline = new AbortController();
        const signal = AbortSignal.any([deadline.signal, this.evidenceValidity.signal]);
        // Start the budget at SDK invocation, including time behind earlier API work.
        return new Promise<string>((resolve) => {
          let settled = false;
          const complete = (result: typeof unavailable) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const text = JSON.stringify(result);
            this.record({ role: 'tool', tool_name: tool.name, text });
            resolve(text);
          };
          const timer = setTimeout(
            () => {
              deadline.abort();
              complete(unavailable);
            },
            tool.response_timeout_secs * 1000 - 1000,
          );
          void this.schedule(async () => {
            const end = await evidence;
            const body = {
              parameters: { ...Object.fromEntries(optional.map((k) => [k, null])), ...parameters },
              session_id: this.credentials.session_id,
              last_transcript_seq: end,
            };
            let result = unavailable;
            let submitted = false;
            for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
              try {
                await this.flush(end, false, signal);
                signal.throwIfAborted();
                submitted = true;
                result = await this.request('/tools/' + tool.name, body, key, false, signal);
                if (result.error?.code !== 'transcript_not_synced') break;
                const expected = (result.error as { expected_seq?: number }).expected_seq;
                if (expected && expected <= end) this.synced = expected - 1;
              } catch {
                result = unavailable;
              }
            }
            complete(result);
            // These writes and the dashboard refresh stay ordered with finalization,
            // but neither delays the response to the voice agent.
            try {
              await this.flush(this.entries.length);
            } catch {
              this.report('Transcript sync delayed.');
            }
            if (result.ok || (submitted && result.error?.code === 'backend_unavailable')) {
              try {
                await this.refresh();
              } catch {
                this.report('Could not refresh captured intents.');
              }
            }
          });
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

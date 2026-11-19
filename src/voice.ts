import { tradingRequest, type Proposal, type Availability } from './browserTrading';
import type { Callbacks, AudioAlignmentPlaybackEvent } from '@elevenlabs/client';
import { Session, startCredentials, type Entry, type Intent } from './session';

export type VoiceView = {
  proposal: Proposal | null;
  availability: Availability | null;
  tradeMessage: string;
  status: string;
  entries: Entry[];
  intents: Intent[];
  draft: string;
  error: string;
};
export const initial: VoiceView = {
  proposal:null, availability:null, tradeMessage:"",
  status: 'Idle',
  entries: [],
  intents: [],
  draft: '',
  error: '',
};

export class Voice {
  private attempt = 0;
  private active = false;
  private session: Session | undefined;
  private conversation: undefined | { endSession: () => Promise<void> };
  private finishSpeech: undefined | (() => void);
  constructor(
    private update: (patch: Partial<VoiceView>) => void,
    private marketAction: (name: 'search_markets' | 'get_orderbook', params: Record<string, unknown>) => Promise<unknown>,
  ) {}

  async start() {
    if (this.active) return;
    this.active = true;
    const id = ++this.attempt;
    const current = () => this.attempt === id;
    const update = (patch: Partial<VoiceView>) => {
      if (current()) this.update(patch);
    };
    update({ ...initial, status: 'Requesting microphone' });
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Microphone unavailable. Open this page on localhost or HTTPS.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!current()) return;
      update({ status: 'Connecting' });
      const credentials = await startCredentials();
      const session = new Session(
        credentials,
        (entries) => update({ entries }),
        (intents) => update({ intents }),
        (error) => update({ error }),
      );
      if (!current()) {
        await session.close();
        return;
      }
      this.session = session;
      let draft: string | undefined;
      let draftEvent: number | undefined;
      let interrupted = false;
      let speaking = false;
      let playbackEnded = false;
      let completedText: string | undefined;
      let cutoff: string | undefined;
      let pendingUser:
        | { text: string; resolve: (seq: number) => void; timer: ReturnType<typeof setTimeout> }
        | undefined;
      let chunks: (AudioAlignmentPlaybackEvent & { start: number })[] = [];
      let finishTimer: ReturnType<typeof setTimeout> | undefined;
      let sealedResponse: { id: number; text: string } | undefined;
      const turnChunks = () =>
        chunks.filter((chunk) => chunk.event_id === (draftEvent ?? chunks[0]?.event_id));
      const heard = () =>
        turnChunks()
          .map(({ alignment, start }) =>
            alignment.chars
              .filter(
                (_, i) =>
                  (alignment.char_start_times_ms[i] ?? Infinity) + (alignment.char_durations_ms[i] ?? Infinity) <=
                  performance.now() - start,
              )
              .join(''),
          )
          .join('');
      // Playback alignment and agent text can differ in spacing, case and final punctuation.
      const comparable = (text: string) =>
        text
          .normalize('NFKC')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .replace(/[.!?]+$/, '');
      const fullyHeard = () =>
        playbackEnded ||
        (draft !== undefined && !!heard().trim() && comparable(heard()) === comparable(draft));
      const finish = (cut: boolean, corrected?: string) => {
        clearTimeout(finishTimer);
        if (draft !== undefined || turnChunks().length) {
          if (draft !== undefined && draftEvent !== undefined)
            sealedResponse = { id: draftEvent, text: draft };
          session.append({
            role: 'agent',
            text: cut ? (corrected ?? cutoff ?? heard()) : (completedText ?? draft ?? heard()),
            ...(cut && { interrupted: true }),
          });
        }
        const completedEvent = draftEvent ?? chunks[0]?.event_id;
        chunks = chunks.filter((chunk) => chunk.event_id !== completedEvent);
        draft = undefined;
        draftEvent = undefined;
        interrupted = false;
        cutoff = undefined;
        playbackEnded = false;
        completedText = undefined;
        update({ draft: '' });
      };
      const finishTurn = (corrected?: string) => {
        // A draft alone is model text. Without a playback end or fully played alignment,
        // the server must receive only the known prefix and refuse this readback.
        finish(interrupted || corrected !== undefined || !fullyHeard(), corrected);
        if (pendingUser) {
          const { text, resolve, timer } = pendingUser;
          clearTimeout(timer);
          pendingUser = undefined;
          session.pendingEvidence = undefined;
          session.append({ role: 'user', text });
          resolve(session.entries.length);
        }
      };
      this.finishSpeech = () => finishTurn();
      const callbacks: Callbacks = {
        onConnect: ({ conversationId }) => {
          if (!current()) return;
          session.conversationId = conversationId;
          session.sync();
          update({ status: 'Listening' });
        },
        onModeChange: ({ mode }) => {
          if (!current()) return;
          if (mode === 'speaking') {
            clearTimeout(finishTimer);
            playbackEnded = false;
            completedText = undefined;
          }
          if (mode === 'listening' && speaking && !interrupted) {
            if (draft !== undefined || chunks.length) {
              const aligned = comparable(
                turnChunks()
                  .map((chunk) => chunk.alignment.chars.join(''))
                  .join(''),
              );
              const response = comparable(draft ?? '');
              // A partial prefix is positive evidence of missing audio, even if a
              // listening notification arrived after the buffer drained.
              playbackEnded = !aligned || aligned === response || !response.startsWith(aligned);
              if (aligned && response && aligned !== response && playbackEnded) {
                completedText = turnChunks()
                  .map((chunk) => chunk.alignment.chars.join(''))
                  .join('');
              }
              if (playbackEnded && !pendingUser) {
                clearTimeout(finishTimer);
                finishTimer = setTimeout(() => finishTurn(), 250);
              }
            }
          }
          speaking = mode === 'speaking';
          update({ status: speaking ? 'Speaking' : 'Listening' });
        },
        onAudioAlignmentPlayback: (event) => {
          if (current() && event.event_id !== sealedResponse?.id)
            chunks.push({ ...event, start: performance.now() });
        },
        onInterruption: () => {
          if (current()) {
            interrupted = true;
            cutoff = heard();
          }
        },
        onAgentResponseCorrection: (correction) => {
          if (!current()) return;
          if (draft === correction.original_agent_response) {
            finishTurn(correction.corrected_agent_response);
          } else if (
            sealedResponse?.id === correction.event_id &&
            sealedResponse.text === correction.original_agent_response
          ) {
            // The append-only transcript already contains the original. Preserve the
            // correction and close the session so it cannot authorize a later call.
            session.invalidateEvidence();
            session.append({
              role: 'agent',
              text: correction.corrected_agent_response,
              interrupted: true,
            });
            void this.stop(
              'Playback was corrected after transcript sync. Start voice for a new readback.',
            );
          }
        },
        onMessage: ({ role, message, event_id }) => {
          if (!current()) return;
          if (role === 'agent') {
            if (pendingUser || (draftEvent !== undefined && draftEvent !== event_id)) finishTurn();
            draft = message;
            draftEvent = event_id;
            update({ draft });
          } else {
            if (pendingUser) finishTurn();
            if (draft !== undefined || chunks.length) {
              // The ASR result may beat playback completion or correction. Hold both
              // transcript sequence and any tool that needs this yes for a bounded grace.
              session.pendingEvidence = new Promise((resolve) => {
                const timer = setTimeout(() => finishTurn(), 250);
                pendingUser = { text: message, resolve, timer };
              });
            } else {
              finishTurn();
              session.append({ role, text: message });
            }
          }
        },
        onDisconnect: (details) => {
          if (current())
            void this.stop(
              details.reason === 'error' ? 'Connection lost. Start voice to reconnect.' : '',
            );
        },
        onError: (message) => update({ error: message }),
      };
      const { Conversation } = await import('@elevenlabs/client');
      if (!current()) return;
      const conversation = await Conversation.startSession({
        signedUrl: credentials.signed_url,
        connectionType: 'websocket',
        clientTools: {
          ...session.tools,
          prepare_sandbox_buy: async (params: Record<string, unknown>) => {
            if (!current()) return JSON.stringify({ok:false,message:'Session ended.'});
            // The session token stays in the browser; the model only sees the tool result below.
            const result = await tradingRequest('proposals',params,credentials.session_token);
            update({ proposal:result.proposal ?? null, availability:result.availability ?? null, tradeMessage:result.message ?? '' });
            return JSON.stringify(result.ok ? {ok:true, proposal:result.proposal, approval_available:result.availability.execution_enabled,
              next_step:'Review the proposal in the dashboard. Approval is a separate private UI action.'} : result);
          },
          ...Object.fromEntries((['search_markets', 'get_orderbook'] as const).map(name => [
            name, async (params: Record<string, unknown>) => JSON.stringify(current()
              ? await this.marketAction(name, params) : { ok: false, error: 'Session ended.' }),
          ])),
        },
        ...callbacks,
      });
      if (!current()) {
        await conversation.endSession();
        return;
      }
      this.conversation = conversation;
    } catch (error) {
      if (!current()) return;
      const denied =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(String(error.name));
      const message = error instanceof Error ? error.message : 'Voice connection failed.';
      await this.stop(
        denied ? 'Microphone blocked. Allow access for this site and start voice again.' : message,
      );
    }
  }

  async approve(proposalId: string,pin: string) {
    const session = this.session;
    if (!session || !this.active) return;
    const result = await tradingRequest('approve',{proposal_id:proposalId,pin},session.credentials.session_token);
    if (session !== this.session) return;
    // Show exactly what Gemini returned: order id and exchange status, never an inferred fill.
    const exchange = result.order_id
      ? ` Gemini Sandbox order ${result.order_id} · status ${result.exchange_status ?? 'unknown'} · ${result.outcome_summary}.`
      : result.outcome_summary ? ` Result: ${result.outcome_summary}.` : '';
    this.update({tradeMessage:(result.say ?? result.message ?? '') + exchange,
      ...(!['WRONG_PIN','BAD_INPUT'].includes(result.error) && {proposal:null})});
  }

  async stop(error = '') {
    if (!this.active) return;
    this.finishSpeech?.();
    const closing = ++this.attempt;
    this.update({ proposal:null, status: 'Ending session', draft: '', error });
    const conversation = this.conversation,
      session = this.session;
    this.conversation = undefined;
    this.session = undefined;
    this.finishSpeech = undefined;
    const results = await Promise.allSettled([conversation?.endSession(), session?.close()]);
    if (closing === this.attempt) {
      this.active = false;
      this.update({
        status: 'Idle',
        ...(session && { entries: [...session.entries], intents: session.captured }),
        ...(results.some((r) => r.status === 'rejected') && {
          error: 'Session closed. Could not verify final transcript sync.',
        }),
      });
    }
  }
}

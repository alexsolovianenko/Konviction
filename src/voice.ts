import type { Callbacks, AudioAlignmentPlaybackEvent } from '@elevenlabs/client';
import { Session, startCredentials, type Entry, type Intent } from './session';

export type VoiceView = {
  status: string;
  entries: Entry[];
  intents: Intent[];
  draft: string;
  error: string;
};
export const initial: VoiceView = {
  status: 'Idle',
  entries: [],
  intents: [],
  draft: '',
  error: '',
};

export class Voice {
  private attempt = 0;
  private active = false;
  private session?: Session;
  private conversation?: { endSession: () => Promise<void> };
  private finishSpeech?: () => void;
  constructor(private update: (patch: Partial<VoiceView>) => void) {}

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
      let interrupted = false;
      let speaking = false;
      let cutoff: string | undefined;
      let chunks: (AudioAlignmentPlaybackEvent & { start: number })[] = [];
      const heard = () =>
        chunks
          .map(({ alignment, start }) =>
            alignment.chars
              .filter(
                (_, i) =>
                  alignment.char_start_times_ms[i] + alignment.char_durations_ms[i] <=
                  performance.now() - start,
              )
              .join(''),
          )
          .join('');
      const finish = (cut: boolean, corrected?: string) => {
        if (draft !== undefined || chunks.length) {
          session.append({
            role: 'agent',
            text: cut ? (corrected ?? cutoff ?? heard()) : (draft ?? heard()),
            ...(cut && { interrupted: true }),
          });
        }
        draft = undefined;
        interrupted = false;
        chunks = [];
        cutoff = undefined;
        update({ draft: '' });
      };
      this.finishSpeech = () => finish(true);
      const callbacks: Callbacks = {
        onConnect: ({ conversationId }) => {
          if (!current()) return;
          session.conversationId = conversationId;
          session.sync();
          update({ status: 'Listening' });
        },
        onModeChange: ({ mode }) => {
          if (!current()) return;
          if (mode === 'listening' && speaking && !interrupted && draft !== undefined) {
            const aligned = chunks.map((chunk) => chunk.alignment.chars.join('')).join('');
            if (!chunks.length || aligned.trim() === draft.trim()) finish(false);
          }
          speaking = mode === 'speaking';
          update({ status: speaking ? 'Speaking' : 'Listening' });
        },
        onAudioAlignmentPlayback: (event) => {
          if (current()) chunks.push({ ...event, start: performance.now() });
        },
        onInterruption: () => {
          if (current()) {
            interrupted = true;
            cutoff = heard();
          }
        },
        onAgentResponseCorrection: (correction) => {
          if (current() && draft === correction.original_agent_response)
            finish(true, correction.corrected_agent_response);
        },
        onMessage: ({ role, message }) => {
          if (!current()) return;
          if (role === 'agent') {
            if (draft !== undefined && draft !== message) finish(true);
            draft = message;
            update({ draft });
          } else {
            finish(interrupted || speaking || draft !== undefined);
            session.append({ role, text: message });
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
        clientTools: session.tools,
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

  async stop(error = '') {
    if (!this.active) return;
    this.finishSpeech?.();
    const closing = ++this.attempt;
    this.update({ status: 'Ending session', draft: '', error });
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

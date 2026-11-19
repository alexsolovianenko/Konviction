import { tradingRequest, type Proposal, type Availability } from './browserTrading';
import type { Callbacks, AudioAlignmentPlaybackEvent } from '@elevenlabs/client';
import { Session as LocalSession, startCredentials as localCredentials, type Entry, type Intent } from './session';
import { Session as WorkerSession, startCredentials as workerCredentials } from './workerSession';
import { workerTrading } from './browserTrading';
const Session = workerTrading ? WorkerSession : LocalSession;
const startCredentials = workerTrading ? workerCredentials : localCredentials;

export type VoicePosition = {
  event_title: string | null; contract_label: string | null; outcome: string | null;
  quantity: number | null; average_price: number | null; market_value_usd: number | null;
  unrealized_pnl_usd: number | null; net_profit_usd: number | null;
  mark_price: number | null; current_bid: number | null; on_screen: boolean;
};
type VoiceSettlement = {
  event_title: string | null; contract_label: string | null; outcome: string | null;
  quantity: number | null; resolution: string | null; payout_usd: number | null;
  net_profit_usd: number | null; settled_at: string | null; on_screen: boolean;
};
type PositionSnapshot = {
  as_of: string; positions: VoicePosition[]; settlements: VoiceSettlement[];
  positions_available: boolean; settlements_available: boolean;
};
export type VoiceView = {
  positionSnapshot: PositionSnapshot | null;
  proposal: Proposal | null;
  availability: Availability | null;
  tradeMessage: string;
  status: string;
  entries: Entry[];
  intents: Intent[];
  draft: string;
  error: string;
};
const shortTradeIssue: Record<string, string> = {
  NO_LIQUIDITY: 'No ask right now.',
  NO_BID: 'No bid right now.',
  PRICE_MOVED: 'Price changed. Requote?',
  PRICE_ABOVE_YOUR_MAX: 'Ask exceeds your limit.',
  TOO_CLOSE_TO_EXPIRY: 'Final ten seconds. Next window?',
  CONTRACT_NOT_OPEN: 'Contract unavailable. Another window?',
  MARKET_DATA_UNAVAILABLE: 'Fresh quote unavailable.',
  BELOW_CONTRACT_MINIMUM: 'Below the contract minimum.',
  CAP_EXCEEDED: 'Outside the trading limit.',
  LIMIT_PRICE_CAP: 'Above the allowed price.',
  BAD_INPUT: 'Please clarify the order terms.',
  COMBO_UNAVAILABLE: 'That combo is unavailable.',
  RISK_UNAVAILABLE: 'Spending check unavailable.',
  EXECUTION_DISABLED: 'Sandbox trading is disabled.',
  SERVICE_UNAVAILABLE: 'Trading service unavailable.',
  UNAUTHORIZED: 'Restart voice to trade.',
  NO_SESSION: 'Start voice to trade.',
  SESSION_ENDED: 'Session ended.',
  LOCKED: 'Approval is locked.',
  SUPERSEDED: 'The proposal changed.',
  UNKNOWN_PROPOSAL: 'Request a fresh proposal.',
  IN_PROGRESS: 'Order already processing.',
  RESULT_UNAVAILABLE: 'Order status is unconfirmed.',
  INACTIVE: 'Request a fresh quote.',
  EXPIRED: 'Quote expired. Requote?',
};

export const initial: VoiceView = {
  proposal:null, availability:null, tradeMessage:"", positionSnapshot:null,
  status: 'Idle',
  entries: [],
  intents: [],
  draft: '',
  error: '',
};

function voiceError(message: string, fallback = message) {
  return /(?:the )?ai agent you are trying to reach is not available/i.test(message)
    ? "ElevenLabs reported that the agent is unavailable."
    : fallback;
}

function endsConversation(message: string) {
  const words = message.toLowerCase().replace(/[’']/g, "").replace(/[.,!?]/g, " ").trim().replace(/\s+/g, " ");
  return /^(?:(?:ok|okay|thanks|thank you) )?(?:done|im done|were done|all done|thats all|that is all|bye|goodbye|hang up|(?:end|stop|close) (?:the |this )?(?:call|session|conversation))(?:(?: please| thanks| thank you| bye))*$/.test(words);
}

export class Voice {
  private attempt = 0;
  private active = false;
  private session: WorkerSession | LocalSession | undefined;
  private conversation: undefined | { endSession: () => Promise<void>; getOutputVolume: () => number; sendContextualUpdate: (text: string) => void };
  private visibleContract = "";
  private currentProposal: Proposal | null = null;
  private approving = false;
  private proposalRequest: Record<string, unknown> | null = null;
  private finishSpeech: undefined | (() => void);
  constructor(
    private update: (patch: Partial<VoiceView>) => void,
    private marketAction: (name: 'search_markets' | 'get_orderbook', params: Record<string, unknown>) => Promise<unknown>,
  ) {}

  setVisibleContract(eventTicker?: string, symbol?: string) {
    const selection = eventTicker && symbol ? JSON.stringify({event_ticker:eventTicker, contract_symbol:symbol}) : "";
    if (selection === this.visibleContract) return;
    this.visibleContract = selection;
    this.conversation?.sendContextualUpdate?.(selection
      ? "Contract on screen (silent tool context): " + selection
      : "The contract chart is no longer visible.");
  }

  outputLevel() {
    return this.conversation?.getOutputVolume?.() ?? 0;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    const id = ++this.attempt;
    const current = () => this.attempt === id;
    const update = (patch: Partial<VoiceView>) => {
      if (current()) this.update(patch);
    };
    let stage = 'Microphone';
    let callId = '';
    const report = (message: string) => [stage, message, callId].filter(Boolean).join(' · ');
    update({ ...initial, status: 'Requesting microphone' });
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Microphone unavailable. Open this page on localhost or HTTPS.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (!current()) return;
      update({ status: 'Connecting' });
      stage = 'Voice credentials';
      const credentials = await startCredentials();
      stage = 'ElevenLabs connection';
      const signedId = new URL(credentials.signed_url).searchParams.get('conversation_id');
      if (signedId && /^conv_[A-Za-z0-9_-]+$/.test(signedId)) callId = signedId;
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
      let providerError = "";
      const callbacks: Callbacks = {
        onConnect: ({ conversationId }) => {
          if (!current()) return;
          stage = 'Voice session';
          callId = conversationId;
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
            if (endsConversation(message)) {
              finishTurn();
              session.append({ role, text: message });
              void this.stop();
              return;
            }
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
          if (!current()) return;
          if (details.reason === 'user') { void this.stop(); return; }
          const code = details.closeCode ?? details.context?.code;
          const reason = details.closeReason || details.context?.reason;
          const failed = Boolean(providerError) || details.reason === 'error' || (code !== undefined && code >= 3000);
          const message = providerError || reason || (details.reason === 'error' ? details.message : 'Connection closed.');
          void this.stop(failed ? report([voiceError(message), code].filter(Boolean).join(' · ')) : '');
        },
        onError: (message) => { providerError = voiceError(message); update({error:report(providerError)}); },
      };
      const { Conversation } = await import('@elevenlabs/client');
      if (!current()) return;
      const conversation = await Conversation.startSession({
        signedUrl: credentials.signed_url,
        connectionType: 'websocket',
        clientTools: {
          ...session.tools,
          prepare_sandbox_buy: async (params: Record<string, unknown>) => {
            if (!current()) return JSON.stringify({ok:false,say:'Session ended.'});
            const result = await this.prepareBuy(params);
            if (!result.ok) {
              const error = result.error?.code ?? (typeof result.error === 'string' ? result.error : 'PROPOSAL_UNAVAILABLE');
              let say = shortTradeIssue[error] ?? 'Couldn’t prepare the order.';
              if (error === 'CAP_EXCEEDED') {
                if (/too small to buy even one contract/i.test(result.message)) say = 'Budget is below one contract.';
                else if (/daily/i.test(result.message)) say = 'Daily spending limit reached.';
                else if (/contracts per order/i.test(result.message)) say = 'Too many contracts.';
                else if (/per order/i.test(result.message)) say = 'Over the per-order limit.';
              }
              return JSON.stringify({ok:false, error, say});
            }
            const { quantity, outcome } = result.proposal;
            const paired = result.availability.voice_authorized && result.availability.voice_confirmation_supported;
            const say = !result.availability.execution_enabled ? 'Approval is unavailable.'
              : paired && result.proposal.voice_readback ? result.proposal.voice_readback
              : 'Ready for approval on screen.';
            return JSON.stringify({ok:true, quantity, outcome, say});
          },
          confirm_sandbox_buy: async () => JSON.stringify(current()
            ? await this.confirmByVoice() : {ok:false, say:'Session ended.'}),
          get_sandbox_positions: async () => JSON.stringify(current()
            ? await this.readPositions() : {ok:false, say:'Session ended.'}),
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
      if (this.visibleContract) conversation.sendContextualUpdate?.("Contract on screen (silent tool context): " + this.visibleContract);
    } catch (error) {
      if (!current()) return;
      const denied =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(String(error.name));
      const message = error instanceof Error ? voiceError(error.message) : 'Voice connection failed.';
      await this.stop(
        report(denied ? 'Microphone blocked. Allow access for this site and start voice again.' : message),
      );
    }
  }

  async prepareBuy(params: Record<string, unknown>) {
    const session = this.session;
    if (!this.active || !session) return {ok:false, message:'Start voice to prepare a proposal.', error:'NO_SESSION'};
    if (!session.credentials.session_token) {
      const message = 'This session opened with quotes only. Restart voice to request trading access.';
      this.update({tradeMessage:message});
      return {ok:false, message, error:'UNAUTHORIZED'};
    }
    const result = await tradingRequest('proposals', params, session.credentials.session_token, {idempotencyKey:crypto.randomUUID()});
    if (session !== this.session) return {ok:false, message:'Session ended.', error:'SESSION_ENDED'};
    this.currentProposal = result.proposal ?? null;
    this.proposalRequest = result.proposal ? {...params} : null;
    this.update({proposal:this.currentProposal, availability:result.availability ?? null, tradeMessage:result.message ?? ''});
    return result;
  }

  async pairDevice(credentials: { pairing_token: string } | { pin: string }) {
    const paired = await tradingRequest('pair', credentials);
    if (!paired.ok) {
      this.update({ tradeMessage: paired.message ?? 'Device pairing failed.' });
      return false;
    }
    const availability = paired;
    this.update({availability, tradeMessage:'This browser is paired for sandbox trading.'});
    // Proposals created before pairing were never bound to this device. Refresh the
    // original request at current prices before offering a spoken confirmation.
    if (this.currentProposal && this.proposalRequest && !this.currentProposal.voice_readback) {
      await this.prepareBuy(this.proposalRequest);
    }
    if (availability.voice_authorized && this.currentProposal?.voice_readback) {
      this.conversation?.sendContextualUpdate?.(
        'This browser was paired. Before confirming this proposal, speak this exact readback and wait for the user: '
        + this.currentProposal.voice_readback,
      );
    }
    return true;
  }

  private async confirmByVoice() {
    const session = this.session;
    const proposal = this.currentProposal;
    if (!this.active || !session) return {ok:false, say:'Session ended.'};
    if (!proposal) return {ok:false, say:'No pending proposal.'};
    if (!(session instanceof LocalSession) || !proposal.voice_readback)
      return {ok:false, say:'Approve the order on screen.'};
    if (this.approving) return {ok:false, say:'Checking your order.'};
    this.approving = true;
    try {
      const sequence = await session.confirmationSequence().catch(() => null);
      if (this.session !== session || this.currentProposal !== proposal) return {ok:false, say:'The proposal changed.'};
      if (!sequence) return {ok:false, say:proposal.voice_readback};
      const result = await tradingRequest('voice-confirm', {
        proposal_id: proposal.proposal_id, confirmation_seq: sequence,
      }, session.credentials.session_token);
      if (session !== this.session) return {ok:false, say:'Session ended.'};
      if (result.outcome_summary) {
        this.showExchangeResult(result);
        const fills: Record<string, string> = {
          FILLED: 'Filled in the sandbox.', PARTIAL: `Sandbox filled ${result.filled_quantity} of ${proposal.quantity}.`,
          NOT_FILLED: `No fills at ${Math.round(proposal.limit_price * 100)} cents.`, PENDING_UNKNOWN: 'Fill status is pending.',
          EXCHANGE_REJECTED: result.voice_say ?? 'Exchange rejected the order.',
        };
        return {ok:result.ok, say:fills[result.outcome_summary] ?? 'Order status is unconfirmed.'};
      }
      const code = typeof result.error === 'string' ? result.error : result.error?.code;
      const terminal = ['INACTIVE', 'EXPIRED', 'SUPERSEDED', 'CAP_EXCEEDED', 'UNKNOWN_PROPOSAL', 'PRICE_MOVED', 'NO_LIQUIDITY', 'CONTRACT_NOT_OPEN', 'TOO_CLOSE_TO_EXPIRY'].includes(code);
      if (terminal) this.currentProposal = null;
      this.update({tradeMessage:result.message ?? 'Check your proposal.', ...(terminal && {proposal:null})});
      if (!code) return {ok:false, say:'Check order history before retrying.'};
      if (code === 'CONFIRMATION_REQUIRED') return {ok:false, say:proposal.voice_readback};
      return {ok:false, say:shortTradeIssue[code] ?? 'Order status is unconfirmed.'};
    } catch {
      return {ok:false, say:'Check order history before retrying.'};
    } finally {
      this.approving = false;
    }
  }

  private async readPositions() {
    const session = this.session;
    if (!(session instanceof LocalSession) || !this.active) return {ok:false, say:'Check positions on screen.'};
    const result = await tradingRequest('portfolio', {}, session.credentials.session_token);
    if (session !== this.session) return {ok:false, say:'Session ended.'};
    if (!result.ok) {
      this.update({tradeMessage:result.message ?? 'Position data unavailable.'});
      return {ok:false, say:'Check positions on screen.'};
    }
    const number = (value: unknown) =>
      (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
    const name = (value: unknown) => typeof value === 'string' && value && !/GEMI-|\b[A-Z]+\d{8,}|\b0x[a-f0-9]{12,}|\b[A-Za-z0-9_-]{28,}\b/i.test(value) ? value : null;
    const symbol = this.visibleContract ? JSON.parse(this.visibleContract).contract_symbol : undefined;
    const positionsAvailable = Array.isArray(result.positions?.rows) && !result.positions.error;
    const settlementsAvailable = Array.isArray(result.settlements?.rows) && !result.settlements.error;
    const positions: VoicePosition[] = (positionsAvailable ? result.positions.rows : []).map((row: Record<string, unknown>) => ({
      event_title: name(row['event_title'] ?? row['title']), contract_label: name(row['contract_label']),
      outcome: name(row['outcome']), quantity: number(row['totalQuantity']), average_price: number(row['avgPrice']),
      market_value_usd: number(row['marketValue']), unrealized_pnl_usd: number(row['unrealizedPnl']),
      net_profit_usd: number(row['netProfit']), mark_price: number(row['markPrice']),
      current_bid: number(row['current_bid']), on_screen: !!symbol && symbol === row['symbol'],
    }));
    const settlements: VoiceSettlement[] = (settlementsAvailable ? result.settlements.rows : []).map((row: Record<string, unknown>) => ({
      event_title: name(row['event_title']), contract_label: name(row['contract_label']),
      outcome: name(row['outcome']), resolution: name(row['resolutionSide']), quantity: number(row['positionQuantity']),
      net_profit_usd: number(row['netProfit']), payout_usd: number(row['payout']),
      settled_at: typeof row['settledAt'] === 'string' ? row['settledAt'] : null,
      on_screen: !!symbol && symbol === row['symbol'],
    }));
    const snapshot = {as_of:result.as_of, positions, settlements, positions_available:positionsAvailable, settlements_available:settlementsAvailable};
    this.update({positionSnapshot:snapshot});
    return {ok:true, ...snapshot};
  }

  private showExchangeResult(result: Awaited<ReturnType<typeof tradingRequest>>) {
    const exchange = result.order_id
      ? ` Gemini Sandbox order ${result.order_id} · status ${result.exchange_status ?? 'unknown'} · ${result.outcome_summary}.`
      : result.outcome_summary ? ` Result: ${result.outcome_summary}.` : '';
    const clear = !['WRONG_PIN','BAD_INPUT'].includes(result.error);
    if (clear) this.currentProposal = null;
    this.update({tradeMessage:(result.say ?? result.message ?? '') + exchange, ...(clear && {proposal:null})});
  }

  async approve(proposalId: string,pin: string) {
    const session = this.session;
    if (!session || !this.active) return;
    const result = await tradingRequest('approve',{proposal_id:proposalId,pin},session.credentials.session_token);
    if (session !== this.session) return;
    this.showExchangeResult(result);
  }

  async stop(error = '') {
    if (!this.active) return;
    this.finishSpeech?.();
    const closing = ++this.attempt;
    this.update({ proposal:null, positionSnapshot:null, status: 'Ending session', draft: '', error });
    const conversation = this.conversation,
      session = this.session;
    this.conversation = undefined;
    this.session = undefined;
    this.currentProposal = null;
    this.proposalRequest = null;
    this.finishSpeech = undefined;
    const results = await Promise.allSettled([conversation?.endSession(), session?.close()]);
    if (closing === this.attempt) {
      this.active = false;
      this.update({
        status: 'Idle',
        ...(session && { entries: [...session.entries], intents: session.captured }),
        ...(results.some((r) => r.status === 'rejected') && {
          error: [error, 'Could not verify final transcript sync.'].filter(Boolean).join(' '),
        }),
      });
    }
  }
}

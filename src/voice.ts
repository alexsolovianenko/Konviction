import { spokenDecision, orderAction } from "./spoken-confirmation";
import { spokenFill } from './spoken-fill';
import { ResearchClient, type ResearchView } from './quicknodeResearch';
import { tradingRequest, type Proposal, type Availability } from './browserTrading';
import type { Callbacks, AudioAlignmentPlaybackEvent } from '@elevenlabs/client';
import { Session as LocalSession, startCredentials as localCredentials, type Entry, type Intent } from './session';
import { Session as WorkerSession, startCredentials as workerCredentials } from './workerSession';
import { workerTrading } from './browserTrading';
const Session = workerTrading ? WorkerSession : LocalSession;
const startCredentials = workerTrading ? workerCredentials : localCredentials;

export type VoicePosition = {
  event_title: string | null; contract_label: string | null; outcome: string | null;
  quantity: number | null; quantity_on_hold: number | null; average_price: number | null; market_value_usd: number | null;
  unrealized_pnl_usd: number | null; realized_pnl_usd: number | null; net_profit_usd: number | null;
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
  research?: ResearchView | null;
  positionSnapshot: PositionSnapshot | null;
  proposal: Proposal | null;
  availability: Availability | null;
  tradeMessage: string;
  remainderQuantity: number | null;
  status: string;
  entries: Entry[];
  intents: Intent[];
  draft: string;
  error: string;
};
const shortTradeIssue: Record<string, string> = {
  NO_LIQUIDITY: 'No ask right now.',
  INSUFFICIENT_POSITION: 'That quantity is unavailable to sell.',
  NO_BID: 'No bid right now.',
  PRICE_MOVED: 'Price changed. Requote?',
  PRICE_ABOVE_YOUR_MAX: 'Ask exceeds your limit.',
  TOO_CLOSE_TO_EXPIRY: 'Final ten seconds. Next window?',
  CONTRACT_NOT_OPEN: 'Contract unavailable. Another window?',
  MARKET_DATA_UNAVAILABLE: 'Fresh quote unavailable.',
  BELOW_CONTRACT_MINIMUM: 'Below the contract minimum.',
  BUDGET_TOO_SMALL: 'Budget is below one contract.',
  INVALID_PRICE: 'Choose one to ninety-nine cents.',
  BAD_INPUT: 'Please clarify the order terms.',
  COMBO_UNAVAILABLE: 'That combo is unavailable.',
  EXECUTION_DISABLED: 'Sandbox trading is disabled.',
  SERVICE_UNAVAILABLE: 'Trading service unavailable.',
  UNAUTHORIZED: 'Restart voice to trade.',
  NO_REMAINDER: 'No confirmed whole-contract remainder.',
  BUSY: 'Checking the current order.',
  NO_SESSION: 'Start voice to trade.',
  SESSION_ENDED: 'Session ended.',
  LOCKED: 'Approval is locked.',
  SUPERSEDED: 'The proposal changed.',
  MARKET_CHANGED: 'Use the selected market.',
  UNKNOWN_PROPOSAL: 'Request a fresh proposal.',
  IN_PROGRESS: 'Order already processing.',
  RESULT_UNAVAILABLE: 'Order status is unconfirmed.',
  INACTIVE: 'Request a fresh quote.',
  EXPIRED: 'Quote expired. Requote?',
};

export const initial: VoiceView = {
  remainderQuantity:null, proposal:null, availability:null, tradeMessage:"", positionSnapshot:null,
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
  private conversation: undefined | { endSession: () => Promise<void>; getOutputVolume: () => number; sendContextualUpdate: (text: string) => void; sendUserMessage: (text: string) => void };
  private visibleContract = "";
  private activeMarketTools = 0;
  private researchDecisions = new Map<string, 'quoted' | 'offered' | 'report' | 'reported' | 'done'>();
  private selectionRevision = 0;
  private currentProposal: Proposal | null = null;
  private approving = false;
  private preparing = false;
  private remainder: {quantity: number; limit_price: number; event_ticker: string; contract_symbol: string; outcome: string} | null = null;
  private proposalRequest: Record<string, unknown> | null = null;
  private postOrderTimer: ReturnType<typeof setTimeout> | undefined;
  private orderReported = false;
  private agentSpeaking = false;
  private postOrderIdle() {
    clearTimeout(this.postOrderTimer);
    if (this.orderReported && !this.agentSpeaking)
      this.postOrderTimer = setTimeout(() => { void this.stop(); }, 10000);
  }
  private finishSpeech: undefined | (() => void);
  constructor(
    private update: (patch: Partial<VoiceView>) => void,
    private marketAction: (name: 'search_markets' | 'get_orderbook', params: Record<string, unknown>) => Promise<unknown>,
    private selectMarket?: (target: { eventTicker: string; symbol: string }) => void,
  ) {}

  private researchClient: ResearchClient | undefined;
  private get research() {
    return this.researchClient ??= new ResearchClient(
      (research) => this.update({research}),
      () => this.session?.credentials.session_token || null,
      () => this.visibleContract ? JSON.parse(this.visibleContract) : null,
    );
  }
  /** On-screen request for an unpaid research price (never pays). */
  requestResearchQuote() { return this.research.requestQuote(); }

  setVisibleContract(eventTicker?: string, symbol?: string) {
    const selection = eventTicker && symbol ? JSON.stringify({event_ticker:eventTicker, contract_symbol:symbol}) : "";
    if (selection === this.visibleContract && (selection || !this.preparing)) return;
    this.visibleContract = selection;
    this.selectionRevision++;
    // Research the newly selected market automatically (free context; unpaid quote with a session).
    this.research.select(eventTicker && symbol ? {event_ticker:eventTicker, contract_symbol:symbol} : null);
    if (this.currentProposal && (this.currentProposal.event_ticker !== eventTicker || this.currentProposal.instrument_symbol !== symbol)) {
      const token = this.session?.credentials.session_token;
      if (token) void tradingRequest('dismiss-proposal', {proposal_id:this.currentProposal.proposal_id}, token);
      this.currentProposal = null;
      this.proposalRequest = null;
    }
    this.remainder = null;
    this.update({proposal:this.currentProposal, tradeMessage:'', remainderQuantity:null, positionSnapshot:null});
    if (selection && this.conversation && !this.activeMarketTools && !this.researchDecisions.has(selection)) this.offerResearch();
    this.conversation?.sendContextualUpdate?.(selection
      ? "Contract on screen (silent tool context): " + selection
      : "The contract chart is no longer visible.");
  }

  private offerResearch() {
    this.conversation?.sendUserMessage?.("I selected a market. Check request_research_quote now and offer optional research for this selection.");
  }

  outputLevel() {
    return this.conversation?.getOutputVolume?.() ?? 0;
  }

  async start(mommyMode = false) {
    if (this.active) return;
    this.researchDecisions.clear();
    this.researchClient = undefined;
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
      // A confirmation belongs to the existing proposal. It cannot start another one.
      let preparedThisTurn = false;
      let confirmedThisTurn = false;
      const waitForUser = JSON.stringify({ ok: false, next_action: 'wait_for_user', say: '' });
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
          this.agentSpeaking = speaking;
          this.postOrderIdle();
          update({ status: speaking ? 'Speaking' : 'Listening' });
        },
        onVadScore: ({ vadScore }) => {
          if (current() && this.orderReported && vadScore > 0.5) this.postOrderIdle();
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
          const selected = this.visibleContract;
          const decision = this.researchDecisions.get(selected);
          if (role === 'agent' && decision === 'quoted' && /quick\s*node/i.test(message) && /research/i.test(message))
            this.researchDecisions.set(selected, 'offered');
          if (role === 'agent' && decision === 'report' && message.trim())
            this.researchDecisions.set(selected, 'reported');
          if (role === 'user' && decision === 'reported' && /[a-z0-9]/i.test(message))
            this.researchDecisions.set(selected, 'done');
          if (role === 'user' && decision === 'offered' &&
              spokenDecision(message, 'research') === 'no')
            this.researchDecisions.set(selected, 'done');
          if (role === 'agent') {
            if (pendingUser || (draftEvent !== undefined && draftEvent !== event_id)) finishTurn();
            draft = message;
            draftEvent = event_id;
            update({ draft });
          } else {
            if (/[a-z0-9]/i.test(message)) {
              this.orderReported = false;
              this.postOrderIdle();
              confirmedThisTurn = false;
              preparedThisTurn = spokenDecision(message, orderAction(this.currentProposal?.side, this.currentProposal?.order_mode)) === "yes";
            }
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
      const researchTools = this.research.tools(current);
      const trackResearch = async (tool: keyof typeof researchTools) => {
        const key = this.visibleContract;
        const value = await researchTools[tool]();
        if (key && key === this.visibleContract && current()) {
          const result = JSON.parse(value);
          if (tool === 'request_research_quote') {
            if (result.next_action === 'ask_for_voice_approval') this.researchDecisions.set(key, 'quoted');
            else if (['paid','free'].includes(result.status) && this.researchDecisions.get(key) !== 'done')
              this.researchDecisions.set(key, 'report');
            else if (result.status === 'context_only' || result.next_action === 'report_result' || result.error)
              this.researchDecisions.set(key, 'done');
          } else if (['paid','free'].includes(result.status) && this.researchDecisions.get(key) !== 'done')
            this.researchDecisions.set(key, 'report');
        }
        return value;
      };
      const conversation = await Conversation.startSession({
        signedUrl: credentials.signed_url,
        ...(mommyMode && {overrides: {tts: {voiceId: 'tQ4MEZFJOzsahSEEZtHK', speed: 0.9}}}),
        connectionType: 'websocket',
        dynamicVariables: {secret__trade_session_token: workerTrading ? (credentials.session_token || 'quotes-only') : 'local'},
        clientTools: {
          ...session.tools,
          build_sandbox_combo: async (params: Record<string, unknown>) => {
            if (!current() || !credentials.session_token) return JSON.stringify({ok:false, say:'Combo creation unavailable.'});
            const revision = this.selectionRevision;
            const result = await tradingRequest('build-combo', {legs:params['legs']}, credentials.session_token);
            if (!current() || this.selectionRevision !== revision) return JSON.stringify({ok:false, say:'Selection changed.'});
            if (result.ok && result.event_ticker && result.contract_symbol)
              this.selectMarket?.({eventTicker:result.event_ticker, symbol:result.contract_symbol});
            return JSON.stringify(result);
          },
          prepare_sandbox_buy: async (params: Record<string, unknown>) => {
            if (!current()) return JSON.stringify({ok:false,say:'Session ended.'});
            if (params['side'] !== 'sell' && params['event_ticker'] && params['contract_symbol']) {
              const target = JSON.stringify({event_ticker:params['event_ticker'], contract_symbol:params['contract_symbol']});
              if (this.visibleContract !== target)
                return JSON.stringify({ok:false,next_action:'select_market',instruction:'Call get_orderbook for this exact contract, then request_research_quote before preparing the trade.'});
              const decision = this.researchDecisions.get(target);
              if (!decision)
                return JSON.stringify({ok:false,next_action:'request_research_quote',instruction:'Call request_research_quote now. Keep the requested order terms for later.'});
              if (decision !== 'done')
                return JSON.stringify({ok:false,next_action:'wait_for_research_decision',instruction:'Finish the research offer first. If purchased, read the result and wait for the caller before preparing a trade.'});
            }
            if (params['order_mode'] !== 'market' && params['limit_price'] == null) return JSON.stringify({ok:false, error:'ENTRY_REQUIRED', say:'Your limit?'});
            if (preparedThisTurn) return waitForUser;
            preparedThisTurn = true;
            const result = await this.prepareBuy(params);
            return this.proposalReply(result);
          },
          prepare_sandbox_remainder: async () => {
            if (!current() || preparedThisTurn) return waitForUser;
            preparedThisTurn = true;
            return this.proposalReply(await this.prepareRemainder());
          },
          confirm_sandbox_buy: async () => {
            if (!current() || confirmedThisTurn) return waitForUser;
            confirmedThisTurn = true;
            preparedThisTurn = true;
            return JSON.stringify(await this.confirmByVoice());
          },
          request_research_quote: () => trackResearch('request_research_quote'),
          get_research_result: () => trackResearch('get_research_result'),
          get_sandbox_positions: async () => JSON.stringify(current()
            ? await this.readPositions() : {ok:false, say:'Session ended.'}),
          ...Object.fromEntries((['search_markets', 'get_orderbook'] as const).map(name => [
            name, async (params: Record<string, unknown>) => {
              if (!current()) return JSON.stringify({ok:false, error:'Session ended.'});
              this.activeMarketTools++;
              try { return JSON.stringify(await this.marketAction(name, params)); }
              finally { this.activeMarketTools--; }
            },
          ])),
        },
        ...callbacks,
      });
      if (!current()) {
        await conversation.endSession();
        return;
      }
      this.conversation = conversation;
      if (mommyMode) conversation.sendContextualUpdate?.(
        'Mommy mode is enabled for this call. Speak warmly and patiently. When explaining a concept, ' +
        'occasionally offer brief encouragement like “Take your time” or “That’s a good question.” ' +
        'Keep exact readbacks and order results verbatim. Encourage learning, never a trade.',
      );
      const localStart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'long',
      }).format(new Date());
      conversation.sendContextualUpdate?.(
        'The caller uses Central time (America/Chicago). Session started ' + localStart +
        '. Interpret unqualified times in Central time. Preserve explicit time zones in searches.',
      );
      if (this.visibleContract) {
        this.research.select(JSON.parse(this.visibleContract));
        conversation.sendContextualUpdate?.("Contract on screen (silent tool context): " + this.visibleContract);
        this.offerResearch();
      }
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

  private proposalReply(result: Awaited<ReturnType<Voice['prepareBuy']>>) {
    if (!result.ok) {
      const error = result.error?.code ?? (typeof result.error === 'string' ? result.error : 'PROPOSAL_UNAVAILABLE');
      const say = shortTradeIssue[error] ?? 'Couldn’t prepare the order.';
      return JSON.stringify({ok:false, error, say, next_action:'wait_for_user'});
    }
    const { quantity, outcome } = result.proposal;
    const canConfirm = result.availability.call_confirmation_supported || (result.availability.voice_authorized && result.availability.voice_confirmation_supported);
    const say = !result.availability.execution_enabled ? 'Approval is unavailable.'
      : canConfirm && result.proposal.voice_readback ? result.proposal.voice_readback
      : 'Call confirmation unavailable.';
    const confirmationTool = workerTrading ? 'confirm_hosted_sandbox_buy' : 'confirm_sandbox_buy';
    return JSON.stringify({ok:true, quantity, outcome, say, confirmation_tool:confirmationTool,
      ...(workerTrading && {proposal_id:result.proposal.proposal_id})});
  }

  async prepareRemainderOnScreen() {
    const result = await this.prepareRemainder();
    if (result.proposal?.voice_readback) this.conversation?.sendContextualUpdate?.(
      "The user requested the remainder on screen. Speak this exact readback and wait for confirmation: " + result.proposal.voice_readback);
  }

  async prepareRemainder() {
    if (!this.remainder) return {ok:false, error:'NO_REMAINDER'};
    return this.prepareBuy(this.remainder);
  }

  async prepareBuy(params: Record<string, unknown>) {
    const session = this.session;
    if (!this.active || !session) return {ok:false, message:'Start voice to prepare a proposal.', error:'NO_SESSION'};
    if (!session.credentials.session_token) {
      const message = 'This session opened with quotes only. Restart voice to request trading access.';
      this.update({tradeMessage:message});
      return {ok:false, message, error:'UNAUTHORIZED'};
    }
    if (this.preparing || this.approving) return {ok:false, error:'BUSY'};
    const requested = JSON.stringify({event_ticker: params['event_ticker'], contract_symbol: params['contract_symbol']});
    if (this.visibleContract && this.visibleContract !== requested) return {ok:false, error:'MARKET_CHANGED'};
    const revision = this.selectionRevision;
    this.preparing = true;
    if (params !== this.remainder) this.remainder = null;
    this.update({remainderQuantity:null});
    try {
      const result = await tradingRequest('proposals', params, session.credentials.session_token, {idempotencyKey:crypto.randomUUID()});
      if (session !== this.session) return {ok:false, message:'Session ended.', error:'SESSION_ENDED'};
      if (this.selectionRevision !== revision) {
        if (result.proposal) await tradingRequest('dismiss-proposal', {proposal_id:result.proposal.proposal_id}, session.credentials.session_token);
        return {ok:false, error:'MARKET_CHANGED'};
      }
      if (result.proposal?.event_ticker) this.selectMarket?.({eventTicker:result.proposal.event_ticker, symbol:result.proposal.instrument_symbol});
      if (result.proposal) this.remainder = null;
      this.currentProposal = result.proposal ?? null;
      this.proposalRequest = result.proposal ? {...params} : null;
      this.update({remainderQuantity:this.remainder?.quantity ?? null, proposal:this.currentProposal, availability:result.availability ?? null, tradeMessage:result.message ?? ''});
      if (workerTrading && result.proposal?.voice_readback)
        void this.watchOrderResult(session, result.proposal);
      return result;
    } finally {
      this.preparing = false;
    }
  }

  async pairDevice(credentials: { pairing_token: string }) {
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
    if (!(session instanceof LocalSession))
      return {ok:false, confirmation_tool:'confirm_hosted_sandbox_buy', proposal_id:proposal.proposal_id, say:'', action:'Use the hosted confirmation tool for this proposal.'};
    if (!proposal.voice_readback) return {ok:false, say:'Call confirmation unavailable.'};
    if (this.preparing || this.approving) return {ok:false, say:'Checking your order.'};
    this.approving = true;
    try {
      const sequence = await session.confirmationSequence().catch(() => null);
      if (this.session !== session || this.currentProposal !== proposal) return {ok:false, say:'The proposal changed.'};
      if (!sequence) return {ok:false, say:'Confirmation missed. Order not sent.'};
      const result = await tradingRequest('voice-confirm', {
        proposal_id: proposal.proposal_id, confirmation_seq: sequence,
      }, session.credentials.session_token);
      if (session !== this.session) return {ok:false, say:'Session ended.'};
      if (result.outcome_summary) {
        this.showExchangeResult(result);
        const spoken = spokenFill(result.outcome_summary, result.filled_quantity, proposal.quantity, result.avg_price);
        const fallback: Record<string, string> = {
          FILLED: 'Filled.', PARTIAL: 'Partially filled.', OPEN: 'Limit order open.',
          NOT_FILLED: 'No fill.', PENDING_UNKNOWN: 'Final fill pending.',
          EXCHANGE_REJECTED: 'Order rejected.',
        };
        return {ok:result.ok, say:result.voice_say ?? spoken ?? result.say ?? fallback[result.outcome_summary] ?? 'Order status unconfirmed.'};
      }
      const code = typeof result.error === 'string' ? result.error : result.error?.code;
      const terminal = ['INACTIVE', 'EXPIRED', 'SUPERSEDED', 'UNKNOWN_PROPOSAL', 'PRICE_MOVED', 'NO_LIQUIDITY', 'CONTRACT_NOT_OPEN', 'TOO_CLOSE_TO_EXPIRY'].includes(code);
      if (terminal) this.currentProposal = null;
      this.update({tradeMessage:result.message ?? 'Check your proposal.', ...(terminal && {proposal:null})});
      if (!code) return {ok:false, say:'Check order history before retrying.'};
      if (code === 'CONFIRMATION_REQUIRED') return {ok:false, say:'Confirmation missed. Order not sent.'};
      return {ok:false, say:shortTradeIssue[code] ?? 'Order status is unconfirmed.'};
    } catch {
      return {ok:false, say:'Check order history before retrying.'};
    } finally {
      this.approving = false;
    }
  }

  private async readPositions() {
    const session = this.session;
    if (!session || !this.active) return {ok:false, say:'Session ended.'};
    const selection = this.visibleContract;
    const result = await tradingRequest('portfolio', {}, session.credentials.session_token);
    if (session !== this.session) return {ok:false, say:'Session ended.'};
    if (selection !== this.visibleContract) return {ok:false, say:'Market changed. Check again.'};
    if (!result.ok) {
      this.update({tradeMessage:result.message ?? 'Position data unavailable.'});
      return {ok:false, say:'Position data unavailable.'};
    }
    const number = (value: unknown) =>
      (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
    const name = (value: unknown) => typeof value === 'string' && value && !/GEMI-|\b[A-Z]+\d{8,}|\b0x[a-f0-9]{12,}|\b[A-Za-z0-9_-]{28,}\b/i.test(value) ? value : null;
    const symbol = this.visibleContract ? JSON.parse(this.visibleContract).contract_symbol : undefined;
    const positionsAvailable = Array.isArray(result.positions?.rows) && !result.positions.error;
    const settlementsAvailable = Array.isArray(result.settlements?.rows) && !result.settlements.error;
    const positions: VoicePosition[] = (positionsAvailable ? result.positions.rows : []).map((row: Record<string, unknown>) => ({
      event_title: name(row['event_title'] ?? row['title']), contract_label: name(row['contract_label']),
      outcome: name(row['outcome']), quantity: number(row['totalQuantity']), quantity_on_hold: number(row['quantityOnHold']), average_price: number(row['avgPrice']),
      market_value_usd: number(row['marketValue']), unrealized_pnl_usd: number(row['unrealizedPnl']), realized_pnl_usd: number(row['realizedPl']),
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
    const orderFeed = (feed: {error?: string; rows?: Record<string, unknown>[]} | undefined) => {
      if (!feed || feed.error || !Array.isArray(feed.rows)) return null;
      const rows = [...feed.rows].sort((a, b) => {
        const onScreen = (row: Record<string, unknown>) => Number(!!symbol && symbol === row['symbol']);
        return onScreen(b) - onScreen(a) || String(b['updatedAt'] ?? '').localeCompare(String(a['updatedAt'] ?? ''));
      });
      return rows.slice(0, 12).map(row => ({
        event_title:name(row['event_title']), contract_label:name(row['contract_label']),
        side:name(row['side']), outcome:name(row['outcome']), status:name(row['status']),
        quantity:number(row['quantity']), filled_quantity:number(row['filledQuantity']),
        remaining_quantity:number(row['remainingQuantity']), average_fill_price:number(row['avgExecutionPrice']),
        limit_price:number(row['price']), on_screen:!!symbol && symbol === row['symbol'],
      }));
    };
    return {ok:true, ...snapshot, open_orders:orderFeed(result.orders), recent_orders:orderFeed(result.history)};
  }

  private showExchangeResult(result: Awaited<ReturnType<typeof tradingRequest>>) {
    this.orderReported = true;
    this.postOrderIdle();
    const exchange = result.order_id
      ? ` Gemini Sandbox order ${result.order_id} · status ${result.exchange_status ?? 'unknown'} · ${result.outcome_summary}.`
      : result.outcome_summary ? ` Result: ${result.outcome_summary}.` : '';
    const clear = result.error !== 'BAD_INPUT';
    if (clear) this.currentProposal = null;
    this.remainder = result.remainder_buy ?? null;
    this.update({remainderQuantity:this.remainder?.quantity ?? null, tradeMessage:(result.say ?? result.message ?? '') + exchange, ...(clear && {proposal:null})});
  }

  private async watchOrderResult(session: WorkerSession | LocalSession, proposal: Proposal) {
    const until = (proposal.confirmationDeadline ?? (performance.now() + Date.parse(proposal.expires_at) - Date.now())) + 45000;
    const current = () => this.active && this.session === session && this.currentProposal === proposal;
    while (current() && performance.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!current()) return;
      const result = await tradingRequest('order-result', {proposal_id:proposal.proposal_id}, session.credentials.session_token);
      if (!current()) return;
      if (result.outcome_summary) {
        this.showExchangeResult(result);
        return;
      }
      if (['INACTIVE','EXPIRED','SUPERSEDED','UNKNOWN_PROPOSAL','UNAUTHORIZED','LOCKED'].includes(result.error)) {
        this.currentProposal = null;
        this.update({proposal:null, tradeMessage:result.message ?? 'Request a fresh quote.'});
        return;
      }
    }
  }

  async stop(error = '') {
    if (!this.active) return;
    this.orderReported = false;
    this.agentSpeaking = false;
    this.postOrderIdle();
    this.finishSpeech?.();
    const closing = ++this.attempt;
    this.remainder = null;
    this.update({ remainderQuantity:null, proposal:null, positionSnapshot:null, status: 'Ending session', draft: '', error });
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

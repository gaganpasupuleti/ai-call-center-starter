import { matchIntent, detectLanguage } from './intent-matcher.js';
import { extractEntities } from './entity-extractor.js';
import { RESPONSES_EN } from './responses.en.js';
import { RESPONSES_TE } from './responses.te.js';
import {
  getConversationState,
  setConversationState,
  incrementUnknownCount,
  resetUnknownCount,
  getUnknownCount,
  recordEngineDecision,
  CONVERSATION_STATES,
} from './conversation-state.js';

/**
 * Deterministic admissions conversation agent (no LLM).
 * Compatible with VoicePipeline agent interface: respond({ text, session }).
 */
export class AdmissionsResponseEngine {
  constructor(options = {}) {
    this.defaultLanguage = options.defaultLanguage === 'te' ? 'te' : 'en';
  }

  async respond({ text, session } = {}) {
    const transcript = text == null ? '' : String(text);
    const sessionLangRaw = String(
      session?.metadata?.sttLanguage ||
        session?.customParameters?.language ||
        session?.customParameters?.stt_language ||
        '',
    )
      .trim()
      .toLowerCase();
    const sessionLang =
      sessionLangRaw === 'te' || sessionLangRaw === 'telugu'
        ? 'te'
        : sessionLangRaw === 'en' || sessionLangRaw === 'english'
          ? 'en'
          : null;
    const detected = detectLanguage(transcript);
    // Prefer the STT session language for TE calls so romanized / noisy
    // Telugu transcripts still use the Telugu intent catalog.
    const language =
      sessionLang === 'te' ? 'te' : detected || sessionLang || this.defaultLanguage;
    const responses = language === 'te' ? RESPONSES_TE : RESPONSES_EN;
    const currentState = getConversationState(session);

    const matched = matchIntent(transcript, {
      language,
      state: currentState,
    });

    let intent = matched.intent || 'UNKNOWN';
    let intentConfidence = matched.confidence ?? 0;
    const entities = extractEntities(transcript, { language });

    // YES/NO mapped by state when confidence is decent
    if (intent === 'YES') {
      if (currentState === CONVERSATION_STATES.waiting_for_demo_interest) {
        intent = 'BOOK_DEMO';
        intentConfidence = Math.max(intentConfidence, 0.8);
      } else if (
        currentState === CONVERSATION_STATES.waiting_for_details_confirmation
      ) {
        intent = 'SEND_DETAILS';
        intentConfidence = Math.max(intentConfidence, 0.8);
      }
    }

    let replyText = '';
    let actions = [];
    let nextState = currentState;
    let unknownCount = getUnknownCount(session);

    if (intent === 'UNKNOWN') {
      unknownCount = incrementUnknownCount(session);
      if (unknownCount === 1) {
        replyText = responses.unknownFirst;
        actions = [];
      } else if (unknownCount === 2) {
        replyText = responses.unknownSecond;
        actions = [];
      } else {
        replyText = responses.unknownDtmf;
        actions = [{ type: 'enable_dtmf_fallback' }];
        nextState = CONVERSATION_STATES.waiting_for_initial_response;
      }
    } else {
      resetUnknownCount(session);
      unknownCount = 0;
      const planned = this.#plan(intent, {
        responses,
        currentState,
        entities,
        transcript,
      });
      replyText = planned.replyText;
      actions = planned.actions;
      nextState = planned.nextState;
    }

    setConversationState(session, nextState);

    const decision = {
      intent,
      intentConfidence,
      replyText,
      language,
      currentState,
      nextState,
      entities,
      actions,
      provider: 'deterministic-response-engine',
    };

    recordEngineDecision(session, {
      transcript,
      intent,
      intentConfidence,
      nextState,
      replyText,
      language,
      unknownCount,
    });

    return decision;
  }

  #plan(intent, { responses, currentState, entities, transcript }) {
    switch (intent) {
      case 'GREETING':
        return {
          replyText: responses.greeting,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_initial_response,
        };
      case 'INTERESTED':
        return {
          replyText: responses.interested,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_demo_interest,
        };
      case 'SEND_DETAILS':
        return {
          replyText: responses.sendDetails,
          actions: [{ type: 'create_follow_up', channel: 'whatsapp' }],
          nextState: CONVERSATION_STATES.waiting_for_demo_interest,
        };
      case 'BOOK_DEMO': {
        const hasWhen = Boolean(entities.relativeDate || entities.time24h);
        if (
          currentState === CONVERSATION_STATES.waiting_for_demo_date ||
          hasWhen
        ) {
          return {
            replyText: responses.bookDemoConfirm,
            actions: [
              {
                type: 'create_demo_request',
                relativeDate: entities.relativeDate || null,
                time: entities.time24h || null,
                rawText: transcript,
              },
            ],
            nextState: CONVERSATION_STATES.completed,
          };
        }
        return {
          replyText: responses.askDemoDate,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_demo_date,
        };
      }
      case 'CALLBACK':
        return {
          replyText: responses.askCallbackTime,
          actions: [{ type: 'collect_callback_time' }],
          nextState: CONVERSATION_STATES.waiting_for_callback_time,
        };
      case 'CALLBACK_TIME':
        return {
          replyText: responses.callbackConfirm,
          actions: [
            {
              type: 'create_callback',
              relativeDate: entities.relativeDate || null,
              time: entities.time24h || null,
              rawText: transcript,
            },
          ],
          nextState: CONVERSATION_STATES.completed,
        };
      case 'ASK_PRICE':
        return {
          replyText: responses.askPrice,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_details_confirmation,
        };
      case 'ASK_COURSE':
        return {
          replyText: responses.askCourse,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_demo_interest,
        };
      case 'ASK_DURATION':
        return {
          replyText: responses.askDuration,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_details_confirmation,
        };
      case 'ASK_LOCATION':
        return {
          replyText: responses.askLocation || responses.askCourse,
          actions: [],
          nextState: currentState,
        };
      case 'ASK_ONLINE_OFFLINE':
        return {
          replyText: responses.askOnlineOffline || responses.askCourse,
          actions: [],
          nextState: currentState,
        };
      case 'NOT_INTERESTED':
        return {
          replyText: responses.notInterested,
          actions: [],
          nextState: CONVERSATION_STATES.completed,
        };
      case 'DO_NOT_CALL':
        return {
          replyText: responses.doNotCall,
          actions: [{ type: 'mark_do_not_call' }],
          nextState: CONVERSATION_STATES.completed,
        };
      case 'HUMAN_AGENT':
        return {
          replyText: responses.humanAgent,
          actions: [{ type: 'transfer_queue', queue: 'admissions' }],
          nextState: CONVERSATION_STATES.waiting_for_human_transfer,
        };
      case 'YES':
        return {
          replyText: responses.yesAck,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_demo_interest,
        };
      case 'NO':
        return {
          replyText: responses.noAck,
          actions: [],
          nextState: CONVERSATION_STATES.waiting_for_initial_response,
        };
      case 'REPEAT':
        return {
          replyText: responses.repeat,
          actions: [],
          nextState: currentState,
        };
      default:
        return {
          replyText: responses.unknownFirst,
          actions: [],
          nextState: currentState,
        };
    }
  }
}

export default AdmissionsResponseEngine;

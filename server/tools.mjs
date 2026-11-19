import { randomUUID } from 'node:crypto';
import { api, requireRule, validIntent } from './contracts.mjs';

const bounded = (text, max) => Array.from(text).slice(0, max).join('');
const { yes_words, allowed_fillers } = api['x-confirmation-enforcement'].explicit_yes;
const fold = (s) =>
  s
    .normalize('NFKC')
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
const plain = (s) =>
  fold(s)
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function reference(s) {
  return fold(s)
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|dash|hyphen)\b/g, (word) =>
      word === 'oh' ? '0' : digits.includes(word) ? String(digits.indexOf(word)) : '',
    )
    .replace(/[^a-z0-9]/g, '')
    .toUpperCase();
}
export function validateQueryParameters(path, parameters) {
  if (path === '/tools/search_markets') requireRule(parameters.query.trim(), 'invalid_parameters');
  if (path === '/tools/get_order_status' && parameters.order_id != null) {
    requireRule(reference(parameters.order_id), 'invalid_parameters');
  }
}
function decimalPlaces(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return (mantissa.split('.')[1]?.length ?? 0) - Number(exponent);
}
function validateOrder(p, market) {
  requireRule(market, 'unknown_instrument');
  requireRule(decimalPlaces(p.limit_price) <= 2, 'invalid_price');
}
function readbackMatches(readback, p, target, cancel, spokenName, precedingUser) {
  const exact = (text) => fold(text).trim().replace(/\s+/g, ' ');
  if (cancel && !target && exact(readback) === 'confirming: cancel the order you just named on gemini prediction. say yes to confirm.') {
    const request = /^(?:please )?cancel (?:the |my )?(?:order )?([a-z0-9 -]+?)(?: please)?[.!]?$/i.exec(precedingUser?.trim() ?? '');
    return Boolean(request && reference(request[1]) === p.order_id);
  }
  if (spokenName) {
    const terms = target ?? p;
    const action = cancel ? 'cancel your prepared order to buy' : 'buy';
    const expected = `Confirming: ${action} ${terms.quantity} ${terms.side} contracts of ${spokenName} on Gemini prediction at a limit of ${Math.round(100 * terms.limit_price)} cents each. Say yes to confirm.`;
    if (exact(readback) === exact(expected)) return true;
  }
  const words =
    fold(readback)
      .replace(/(?<=\d),(?=\d)/g, '')
      .replaceAll('−', '-')
      .match(/-?(?:\.\d+|[a-z0-9]+(?:[._-][a-z0-9]+)*)/g) ?? [];
  const phrase = (s) => (' ' + words.join(' ') + ' ').includes(' ' + s + ' ');
  if (!phrase(p.venue.replace('_', ' ')) || words.includes('cancel') !== cancel) return false;
  if (cancel && !target) return reference(readback).includes(p.order_id);
  const terms = target ?? p;
  const numeric = (word) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(word);
  const priceAt = words.findIndex(
    (word, i) =>
      numeric(word) &&
      ((Number(word) === terms.limit_price && words[i + 1] === 'dollars') ||
        (Number(word) / 100 === terms.limit_price && words[i + 1] === 'cents')),
  );
  return (
    words.includes(terms.instrument.toLowerCase()) &&
    phrase(terms.side + ' contracts') &&
    priceAt >= 0 &&
    words.some((word, i) => i !== priceAt && numeric(word) && Number(word) === terms.quantity)
  );
}

const captureResult = (intent, duplicate) => ({
  ok: true,
  simulated: true,
  duplicate,
  intent,
  say: "I've prepared that for approval.",
});

// Keep the original rows for audit. Only market-data queries may expose the spot venue.
export function visibleIntent(intent) {
  return intent.venue === 'gemini_prediction' || intent.intent === 'market_query';
}

export function runTool(repo, name, p, session, transcript, now, market, legacyMarket) {
  const records = repo.intents(session).filter(({ intent }) => visibleIntent(intent));
  const orders = records.map((row) => row.intent);
  const speech = transcript.filter((entry) => entry.role !== 'tool');
  const users = speech.filter((entry) => entry.role === 'user');
  const userText = users.map((entry) => entry.text).join(' ');
  const utteranceMatches =
    plain(p.utterance).length > 0 && plain(userText).includes(plain(p.utterance));
  const intent = {
    id: randomUUID(),
    session_id: session,
    created_at: new Date(now).toISOString(),
    intent: 'market_query',
    venue: p.venue,
    instrument: p.instrument ?? '',
    side: p.side ?? null,
    quantity: p.quantity ?? null,
    limit_price: p.limit_price ?? null,
    order_id: null,
    confirmed_by_user: false,
    utterance: p.utterance,
    status: 'captured',
  };
  if (name === 'capture_order_intent' || name === 'capture_cancel_intent') {
    const cancel = name === 'capture_cancel_intent';
    intent.intent = cancel ? 'cancel_order' : 'place_order';
    let target;
    if (cancel) {
      target = orders.find((order) => order.id === p.order_id);
      intent.order_id = target?.id ?? reference(p.order_id);
      if (target) {
        requireRule(target.intent === 'place_order', 'order_not_cancellable');
        requireRule(target.venue === p.venue, 'venue_mismatch');
        requireRule(
          p.instrument == null || p.instrument === target.instrument,
          'instrument_mismatch',
        );
        intent.instrument = target.instrument;
      } else {
        requireRule(p.instrument == null || market, 'unknown_instrument');
        requireRule(
          intent.order_id && reference(userText).includes(intent.order_id),
          'order_id_not_user_supplied',
        );
      }
    } else validateOrder(p, market);

    requireRule(p.confirmed_by_user, 'confirmation_required');
    const readbackIndex = speech.findLastIndex((entry) => entry.role === 'agent');
    const run = speech.slice(readbackIndex + 1);
    const confirmation = run.at(-1);
    const received = confirmation && repo.receivedAt(session, confirmation.seq);
    const age = received == null ? Infinity : now - received;
    const answer = run.map((entry) => entry.text).join(' ');
    const words = plain(answer).split(' ');
    requireRule(
      age >= 0 &&
        age <= 120000 &&
        !/[?？]/u.test(answer) &&
        words.some((w) => yes_words.includes(w)) &&
        words.every((w) => yes_words.includes(w) || allowed_fillers.includes(w)),
      'confirmation_missing',
    );
    const readback = speech[readbackIndex];
    requireRule(
      readback?.role === 'agent' &&
        (' ' + plain(readback.text) + ' ').includes(' say yes to confirm '),
      'readback_missing',
    );
    requireRule(!readback.interrupted, 'readback_interrupted');
    let spokenName;
    if (target) {
      spokenName = repo.spokenName(target.id);
      if (spokenName) {
        const cancelled = new Set(orders.filter(o => o.intent === 'cancel_order').map(o => o.order_id));
        const indistinguishable = orders.some(o => o.id !== target.id && o.intent === 'place_order' &&
          !cancelled.has(o.id) && o.side === target.side && o.quantity === target.quantity &&
          o.limit_price === target.limit_price && repo.spokenName(o.id) === spokenName);
        if (indistinguishable) spokenName = undefined;
      }
    } else if (market?.title?.trim() && market?.label?.trim()) {
      spokenName = market.title.trim() + ', ' + market.label.trim();
    }
    const precedingUser = speech[readbackIndex - 1];
    requireRule(readbackMatches(readback.text, intent, target, cancel, spokenName,
      precedingUser?.role === 'user' ? precedingUser.text : undefined), 'readback_mismatch');
    requireRule(utteranceMatches, 'utterance_mismatch');
    // Late ASR fragments can extend an already consumed answer to the same readback.
    const used = records.find(
      (row) => row.seq >= run[0].seq && row.seq <= confirmation.seq,
    )?.intent;
    if (used) {
      const fields = [
        'intent',
        'venue',
        'instrument',
        'side',
        'quantity',
        'limit_price',
        'order_id',
      ];
      requireRule(
        fields.every((key) => used[key] === intent[key]),
        'confirmation_already_used',
        { existing_intent_id: used.id },
      );
      return [200, captureResult(used, true)];
    }
    if (target) {
      const prior = orders.find(
        (order) => order.intent === 'cancel_order' && order.order_id === target.id,
      );
      requireRule(!prior, 'cancel_already_captured', { existing_intent_id: prior?.id });
    }
    intent.confirmed_by_user = true;
    requireRule(validIntent(intent), 'invalid_parameters');
    repo.insert(intent, confirmation.seq, cancel ? undefined : spokenName);
    return [201, captureResult(intent, false)];
  }

  const result = { ok: true, simulated: true, query_intent_id: intent.id };
  if (name === 'get_orderbook') requireRule(market, 'unknown_instrument');
  if (!utteranceMatches) {
    const latestSpeech = users.findLast((entry) => plain(entry.text));
    requireRule(latestSpeech, 'utterance_mismatch');
    intent.utterance = bounded(latestSpeech.text, 2000);
  }
  if (name === 'get_order_status') {
    intent.intent = 'order_status';
    intent.order_id =
      orders.find((order) => order.id === p.order_id)?.id ??
      (p.order_id ? reference(p.order_id) : null);
    const matches = orders.filter(
      (order) =>
        order.intent === 'place_order' &&
        order.venue === p.venue &&
        (!p.instrument || p.instrument === order.instrument) &&
        (!p.side || p.side === order.side) &&
        (!p.order_id || p.order_id === order.id),
    );
    const cancelled = new Set(
      orders.filter((order) => order.intent === 'cancel_order').map((order) => order.order_id),
    );
    result.execution = 'none';
    result.count = matches.length;
    result.matches = matches
      .slice(0, 5)
      .map(({ id, venue, instrument, side, quantity, limit_price, created_at }) => ({
        intent_id: id,
        spoken_name: repo.spokenName(id),
        venue,
        instrument,
        side,
        quantity,
        limit_price,
        created_at,
        capture_status: 'captured',
        cancel_captured: cancelled.has(id),
      }));
  } else {
    legacyMarket(name, p, intent, result);
  }
  if (!validIntent(intent)) throw new Error('Derived audit record failed schema validation');
  repo.insert(intent);
  return [200, result];
}

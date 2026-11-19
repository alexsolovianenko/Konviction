import { randomUUID } from 'node:crypto';
import { api, requireRule, validIntent } from './contracts.mjs';

const catalog = api['x-simulated-catalog'];
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
function decimalPlaces(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return (mantissa.split('.')[1]?.length ?? 0) - Number(exponent);
}
function validateOrder(p, market) {
  const spot = p.venue === 'gemini_spot';
  requireRule(market, 'unknown_instrument');
  requireRule((spot ? ['buy', 'sell'] : ['yes', 'no']).includes(p.side), 'invalid_side_for_venue');
  requireRule(
    spot ? decimalPlaces(p.quantity) <= 8 : Number.isInteger(p.quantity),
    'invalid_quantity',
  );
  requireRule(
    decimalPlaces(p.limit_price) <= 2 && (spot || p.limit_price <= 0.99),
    'invalid_price',
  );
}
function readbackMatches(readback, p, target, cancel) {
  const words =
    fold(readback)
      .replace(/(?<=\d),(?=\d)/g, '')
      .replaceAll('−', '-')
      .match(/-?(?:\.\d+|[a-z0-9]+(?:[.-][a-z0-9]+)*)/g) ?? [];
  const phrase = (s) => (' ' + words.join(' ') + ' ').includes(' ' + s + ' ');
  if (!phrase(p.venue.replace('_', ' ')) || words.includes('cancel') !== cancel) return false;
  if (cancel && !target) return reference(readback).includes(p.order_id);
  const terms = target ?? p;
  const spot = p.venue === 'gemini_spot';
  const numeric = (word) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(word);
  const priceAt = words.findIndex(
    (word, i) =>
      numeric(word) &&
      ((Number(word) === terms.limit_price && words[i + 1] === 'dollars') ||
        (!spot && Number(word) / 100 === terms.limit_price && words[i + 1] === 'cents')),
  );
  return (
    words.includes(terms.instrument.toLowerCase()) &&
    phrase(spot ? terms.side : terms.side + ' contracts') &&
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

export function runTool(repo, name, p, session, transcript, now) {
  const records = repo.intents(session);
  const orders = records.map((row) => row.intent);
  const speech = transcript.filter((entry) => entry.role !== 'tool');
  const users = speech.filter((entry) => entry.role === 'user');
  const userText = users.map((entry) => entry.text).join(' ');
  const utteranceMatches =
    plain(p.utterance).length > 0 && plain(userText).includes(plain(p.utterance));
  const market = catalog[p.venue].find((item) => item.instrument === p.instrument);
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
  const save = (seq) => {
    requireRule(validIntent(intent), 'invalid_parameters');
    repo.insert(intent, seq);
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
        requireRule(
          intent.order_id && reference(userText).includes(intent.order_id),
          'order_id_not_user_supplied',
        );
      }
    } else validateOrder(p, market);

    requireRule(p.confirmed_by_user, 'confirmation_required');
    const confirmation = users.at(-1);
    const age = now - Date.parse(confirmation?.timestamp);
    const words = plain(confirmation?.text ?? '').split(' ');
    requireRule(
      age >= 0 &&
        age <= 120000 &&
        words.some((w) => yes_words.includes(w)) &&
        words.every((w) => yes_words.includes(w) || allowed_fillers.includes(w)),
      'confirmation_missing',
    );
    const readback = speech[speech.indexOf(confirmation) - 1];
    requireRule(
      readback?.role === 'agent' &&
        (' ' + plain(readback.text) + ' ').includes(' say yes to confirm '),
      'readback_missing',
    );
    requireRule(!readback.interrupted, 'readback_interrupted');
    requireRule(readbackMatches(readback.text, intent, target, cancel), 'readback_mismatch');
    requireRule(utteranceMatches, 'utterance_mismatch');
    const used = records.find((row) => row.seq === confirmation.seq)?.intent;
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
    save(confirmation.seq);
    return [201, captureResult(intent, false)];
  }

  const result = { ok: true, simulated: true, query_intent_id: intent.id };
  if (!utteranceMatches) intent.utterance = users.at(-1)?.text ?? '';
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
        venue,
        instrument,
        side,
        quantity,
        limit_price,
        created_at,
        capture_status: 'captured',
        cancel_captured: cancelled.has(id),
      }));
  } else if (name === 'search_markets') {
    intent.instrument = p.query;
    const terms = fold(p.query).match(/[\p{L}\d]{3,}/gu) ?? [];
    const results = catalog[p.venue]
      .filter((item) =>
        terms.every((term) =>
          [item.title, item.instrument, ...item.aliases].some((s) => fold(s).includes(term)),
        ),
      )
      .slice(0, p.limit ?? 3)
      .map(({ aliases, yes_book, bids, asks, ...item }) =>
        bids
          ? { ...item, venue: p.venue, best_bid: bids[0].price, best_ask: asks[0].price }
          : { ...item, venue: p.venue },
      );
    Object.assign(result, {
      venue: p.venue,
      as_of: intent.created_at,
      count: results.length,
      results,
    });
  } else {
    requireRule(market, 'unknown_instrument');
    const book = market.yes_book ?? market;
    const bids = book.bids.slice(0, p.depth ?? 3),
      asks = book.asks.slice(0, p.depth ?? 3);
    const best_bid = bids[0]?.price ?? null,
      best_ask = asks[0]?.price ?? null;
    Object.assign(result, {
      venue: p.venue,
      instrument: market.instrument,
      as_of: intent.created_at,
      bids,
      asks,
      best_bid,
      best_ask,
      spread:
        best_ask == null || best_bid == null ? null : Number((best_ask - best_bid).toFixed(2)),
    });
  }
  save();
  return [200, result];
}

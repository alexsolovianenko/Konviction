import numberToWords from 'number-to-words';

function count(number) {
  if (!Number.isFinite(Number(number)) || Math.abs(Number(number)) > Number.MAX_SAFE_INTEGER) return String(number);
  if (!Number.isInteger(Number(number))) {
    const [whole, fraction] = Number(number).toLocaleString('en-US', {useGrouping:false, maximumFractionDigits:20}).split('.');
    return count(Number(whole)) + ' point ' + Array.from(fraction, digit => count(Number(digit))).join(' ');
  }
  return numberToWords.toWords(number).replace(/[-,]/g, ' ').replace(/ +/g, ' ');
}

function money(amount) {
  const total = Math.round(Number(amount) * 100);
  const dollars = Math.floor(total / 100), cents = total % 100;
  return [dollars && count(dollars) + (dollars === 1 ? ' dollar' : ' dollars'),
    cents && count(cents) + (cents === 1 ? ' cent' : ' cents')].filter(Boolean).join(' and ') || 'zero dollars';
}

function moneyText(match, raw) {
  const value = raw.replaceAll(',', '');
  if (value.length > 15) return match;
  return (value.split('.')[1]?.length ?? 0) > 2 ? count(Number(value)) + ' dollars' : money(Number(value));
}

export function hasSpokenMarketName(terms) {
  return [terms.title, terms.contract_label].every(name => typeof name === 'string' && name.trim() &&
    name !== terms.instrument_symbol && name !== terms.event_ticker &&
    !/GEMI-[A-Z0-9._-]+|0x[0-9a-f]{12,}|[A-Z]{2,10}\d{2}[A-Z]?\d{6,}/i.test(name));
}

// Provider transcripts may spell the same number as words, digits, currency or percent.
export function normalizeReadback(value) {
  return value.normalize('NFKC').toLowerCase().replace(/^\[(?:neutral|slow)\]\s*/, '')
    .replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)/g, moneyText)
    .replace(/(\d+(?:\.\d+)?)¢/g, (_, n) => count(Number(n)) + (Number(n) === 1 ? ' cent' : ' cents'))
    .replace(/(\d+(?:\.\d+)?)%/g, (_, n) => count(Number(n)) + ' percent')
    .replace(/(\d)(am|pm)\b/g, '$1 $2').replace(/\b([ap])\.m\./g, '$1m')
    .replace(/-\s*(?=\d)/g, 'minus ').replace(/\+\s*(?=\d)/g, 'plus ')
    .replace(/\b\d+(?:\.\d+)?\b/g, n => n.length <= 12 ? count(Number(n)) : n)
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function spokenProposal(terms) {
  if (terms.side === 'sell') {
    const floor = Math.round(terms.limit_price * 100);
    const price = count(floor) + (floor === 1 ? ' cent' : ' cents');
    const exit = terms.order_mode === 'market' ? ' at market' + (floor > 1 ? ', minimum ' + price : '') : ' at ' + price + ' or more';
    return 'Sell ' + count(terms.quantity) + ' ' + terms.outcome.toLowerCase() + exit + '. Confirm?';
  }
  const cents = Math.round(terms.limit_price * 100);
  const maximum = Number(terms.notional_usd) + Number(terms.est_fee_usd);
  const amount = money(terms.budget_usd ?? maximum);
  const size = terms.budget_usd == null ? count(terms.quantity) + ' ' + terms.outcome.toUpperCase() + ', ' : '';
  const cap = count(cents) + (cents === 1 ? ' cent' : ' cents');
  if (terms.order_mode !== 'market') return size + 'Up to ' + amount + ' at ' + cap + ' each. Confirm?';
  const quote = Number(terms.quote_price);
  const odds = 'Market odds ' + count(Number((quote * 100).toFixed(3))) + ' percent.';
  const lowerCap = Number(terms.limit_price) < quote ? ', at most ' + cap + ' each' : '';
  return odds + ' ' + size + 'Up to ' + amount + lowerCap + '. Buy now?';
}

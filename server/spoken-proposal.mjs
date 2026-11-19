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

function marketName(terms) {
  const assets = {BTC: 'Bitcoin', SOL: 'Solana', ETH: 'Ethereum', XRP: 'X R P'};
  const duration = /^[A-Z]+(\d{2})M\d/.exec(terms.event_ticker ?? '');
  const title = terms.title.replace(/\b(BTC|SOL|ETH|XRP)\b/g, key => assets[key]);
  const parts = [title];
  const expiry = new Date(terms.contract_expiry ?? NaN);
  if (Number.isFinite(expiry.getTime()) && !/\b(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|noon|midnight)\b/i.test(title)) {
    const timeZone = 'America/New_York';
    const time = new Intl.DateTimeFormat('en-US', {timeZone, hour: 'numeric', minute: '2-digit'}).format(expiry).replace(':00', '');
    const date = new Intl.DateTimeFormat('en-US', {timeZone, month: 'long', day: 'numeric'}).format(expiry);
    const hasDate = /\b(?:today|tomorrow|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*\d{0,2}\b/i.test(title);
    parts.push((hasDate ? '' : date + ' at ') + time + ' Eastern');
  }
  if (duration && !/min(?:ute)?/i.test(title)) parts.push(count(Number(duration[1])) + ' minute');
  if (!title.toLowerCase().includes(terms.contract_label.toLowerCase())) parts.push(terms.contract_label);
  return parts.join(', ').replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)/g, moneyText)
    .replace(/\b(\d{1,2})(am|pm)\b/gi, (_, hour, period) => count(Number(hour)) + ' ' + period.toUpperCase())
    .replace(/\b(?:EST|EDT|ET)\b/g, 'Eastern');
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
  const size = terms.budget_usd != null ? '' : 'Buy ' + count(terms.quantity) + ' ';
  const market = marketName(terms);
  const cap = count(cents) + (cents === 1 ? ' cent' : ' cents');
  const cost = money(maximum) + ' max including about ' + money(terms.est_fee_usd) + ' in fees.';
  const odds = terms.order_mode === 'market' ? ', about ' + count(cents) + ' percent market-implied.' : '.';
  const choice = terms.order_mode === 'market' ? ' Buy now or set a price?' : ' Place this limit order?';
  return size + terms.outcome.toUpperCase() + ' on ' + market + '. Up to ' + cap + ' each' + odds + ' ' + cost + choice;
}

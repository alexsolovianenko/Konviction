import numberToWords from 'number-to-words';

function count(number) {
  return numberToWords.toWords(number).replace(/[-,]/g, ' ').replace(/ +/g, ' ');
}

function dollars(amount) {
  const total = Math.round(amount * 100);
  const whole = Math.floor(total / 100);
  const cents = total % 100;
  const parts = [];
  if (whole || !cents) parts.push(count(whole) + (whole === 1 ? ' dollar' : ' dollars'));
  if (cents) parts.push(count(cents) + (cents === 1 ? ' cent' : ' cents'));
  return parts.join(' and ');
}

function spokenLabel(label) {
  return label.replace(/\$(\d[\d,]*(?:\.\d{1,2})?)(?![\d.])/g, (_, price) => dollars(Number(price.replaceAll(',', ''))))
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (_, hour, minute, period) =>
      [count(Number(hour)), minute && minute !== '00' ? (Number(minute) < 10 ? 'oh ' : '') + count(Number(minute)) : '', period.toLowerCase().split('').join(' ')].filter(Boolean).join(' '))
    .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})\b/g,
      (_, month, day) => month + ' ' + numberToWords.toWordsOrdinal(Number(day)).replaceAll('-', ' '))
    .replace(/\b(?:EST|EDT)\b/g, 'Eastern');
}

export function spokenProposal(terms) {
  const cents = Math.round(terms.limit_price * 100);
  const title = spokenLabel(terms.title.replace(/\bprice today at\b/i, 'at'));
  const label = spokenLabel(terms.contract_label);
  const market = title.toLowerCase() === label.toLowerCase() ? title : title + ', ' + label;
  return market + '. Buy ' + count(terms.quantity) + ' ' + terms.outcome.toLowerCase() +
    ' up to ' + count(cents) + (cents === 1 ? ' cent' : ' cents') + '. Confirm?';
}

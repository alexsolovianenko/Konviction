import numberToWords from 'number-to-words';

function count(number) {
  if (!Number.isInteger(Number(number))) {
    const [whole, fraction] = Number(number).toLocaleString('en-US', {useGrouping:false, maximumFractionDigits:20}).split('.');
    return count(Number(whole)) + ' point ' + Array.from(fraction, digit => count(Number(digit))).join(' ');
  }
  return numberToWords.toWords(number).replace(/[-,]/g, ' ').replace(/ +/g, ' ');
}

export function spokenProposal(terms) {
  if (terms.side === 'sell') {
    const floor = Math.round(terms.limit_price * 100);
    const price = count(floor) + (floor === 1 ? ' cent' : ' cents');
    const exit = terms.order_mode === 'market' ? ' at market' + (floor > 1 ? ', minimum ' + price : '') : ' at ' + price + ' or more';
    return 'Sell ' + count(terms.quantity) + ' ' + terms.outcome.toLowerCase() + exit + '. Confirm?';
  }
  if (terms.order_mode === 'market') {
    const total = Math.round((Number(terms.notional_usd) + Number(terms.est_fee_usd)) * 100);
    const dollars = Math.floor(total / 100);
    const cents = total % 100;
    const cost = [dollars && count(dollars) + (dollars === 1 ? ' dollar' : ' dollars'),
      cents && count(cents) + (cents === 1 ? ' cent' : ' cents')].filter(Boolean).join(' and ');
    return 'Market buy up to ' + count(terms.quantity) + ' ' + terms.outcome.toLowerCase() +
      ', up to ' + cost + ' total. Confirm?';
  }
  const cents = Math.round(terms.limit_price * 100);
  return 'Buy ' + count(terms.quantity) + ' ' + terms.outcome.toLowerCase() +
    ' at ' + count(cents) + (cents === 1 ? ' cent' : ' cents') + '. Confirm?';
}

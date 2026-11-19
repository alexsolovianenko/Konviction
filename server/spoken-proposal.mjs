import numberToWords from 'number-to-words';

function count(number) {
  return numberToWords.toWords(number).replace(/[-,]/g, ' ').replace(/ +/g, ' ');
}

export function spokenProposal(terms) {
  const cents = Math.round(terms.limit_price * 100);
  return 'Buy ' + count(terms.quantity) + ' ' + terms.outcome.toLowerCase() +
    ' at ' + count(cents) + (cents === 1 ? ' cent' : ' cents') + '. Confirm?';
}

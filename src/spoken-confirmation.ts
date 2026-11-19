export function isSpokenConfirmation(text: string, immediateBuy = false) {
  if (immediateBuy && /^buy now[.!]?$/i.test(text.trim())) return true;
  return /^(?:yes(?:[, ]+confirm(?:ed)?)?|confirm(?:ed)?)[.!]?$/i.test(text.trim());
}

export function isSpokenConfirmation(text: string) {
  return /^(?:yes(?:[, ]+confirm(?:ed)?)?|confirm(?:ed)?)[.!]?$/i.test(text.trim());
}

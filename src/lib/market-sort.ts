export const marketSortLabels = {
  featured: "Featured",
  volume: "Volume",
  volume_24h: "24h Volume",
  newest: "Newest",
  expiry: "Expiry Date",
} as const;

export type MarketSort = keyof typeof marketSortLabels;

export function isMarketSort(value: unknown): value is MarketSort {
  return typeof value === "string" && Object.hasOwn(marketSortLabels, value);
}

export function normalizeMarketQuery(query: string) {
  return query
    .toLowerCase()
    .replace(/\bbitcoin\b/g, "btc")
    .replace(/\bethereum\b/g, "eth")
    .replace(/\bsolana\b/g, "sol")
    .replace(/\b(?:five|5)[ -]?(?:minutes?|mins?|m)\b/g, "05m")
    .trim();
}

const sortPhrases: [MarketSort, RegExp][] = [
  ["volume_24h", /\b(?:volume\s+(?:in|over|for)\s+(?:the\s+)?(?:last|past)\s+(?:24|twenty[ -]four)\s+hours?|(?:24|twenty[ -]four)[ -]?(?:hours?|hrs?|h)\s+volume|daily\s+volume)\b/gi],
  ["volume", /\b(?:(?:all[ -]time|total|trading)\s+)?volume\b/gi],
  ["newest", /\b(?:newest|latest|recently (?:added|listed)|newly listed|most recent|creation date)\b/gi],
  ["featured", /\bfeatured\b/gi],
  ["expiry", /\b(?:(?:expiry|expiration|closing|end)\s+date|(?:ending|closing|expiring)\s+(?:soonest|soon|first|next))\b/gi],
];

export function browseQuery(raw: string, explicitSort: MarketSort | null) {
  let minVolume: number | null = null;
  let endingMinutes: number | null = null;
  let sort = explicitSort;
  let words = raw.toLowerCase()
    .replace(/\b(?:min(?:imum)?\s+volume|volume\s+(?:at least|above|over|from))\s*\$?([\d,]+(?:\.\d+)?)\s*([km])?\b/g, (_, amount, suffix) => {
      minVolume = Number(amount.replaceAll(",", "")) * (suffix === "k" ? 1000 : suffix === "m" ? 1000000 : 1);
      return " ";
    })
    .replace(/\b(?:ending|closing|expiring)\s+(?:in|within)\s+(?:the next\s+)?(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/g, (_, value, unit) => {
      endingMinutes = Number(value) * (unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1440 : 1);
      return " ";
    });
  for (const [key, pattern] of sortPhrases) {
    words = words.replace(pattern, () => { sort ??= key; return " "; });
  }
  if (endingMinutes !== null) sort ??= "expiry";
  const browsing = minVolume !== null || sort !== null;
  if (browsing) words = words.replace(/\b(?:please|show|me|these|those|this|them|list|the|markets?|events?|contracts?|with|and|sort(?:ed)?|rank(?:ed)?|by|in|order|descending|ascending|first|highest|high|most|top|on|of)\b/g, " ");
  const topic = normalizeMarketQuery(words).replace(/\s+/g, " ").trim();
  const query = [topic, minVolume !== null ? 'minimum volume ' + minVolume : '', endingMinutes !== null ? 'ending within ' + endingMinutes + ' minutes' : ''].filter(Boolean).join(' ');
  return { topic, query, minVolume, endingMinutes, sort, browsing };
}

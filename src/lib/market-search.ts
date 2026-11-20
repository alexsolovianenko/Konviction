import type { MarketContract, MarketEvent } from "../components/console/types";
import { normalizeMarketQuery } from "./market-sort";

const calendarFormat = (timeZone: string) => new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const central = calendarFormat("America/Chicago");
const eastern = calendarFormat("America/New_York");
const zonePattern = /\b(central|eastern)(?: (?:standard|daylight))?(?: time)?\b|\b(?:cst|cdt|ct|est|edt|et)\b/;

function calendar(at: number, format: Intl.DateTimeFormat) {
  const p = Object.fromEntries(
    format.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: p["year"]!,
    month: p["month"]!,
    day: p["day"]!,
    hour: p["hour"]!,
    minute: p["minute"]!,
  };
}

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const monthPattern = months
  .map((m) => (m.length === 3 ? m : m.slice(0, 3) + "(?:" + m.slice(3) + ")?"))
  .join("|");
const monthDate = new RegExp(
  "\\b(" + monthPattern + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b",
  "i",
);
const monthEnd = new RegExp(
  "\\b(?:end of|month end(?: of)?)\\s+(" + monthPattern + ")(?:,?\\s+(20\\d{2}))?\\b",
  "i",
);
const amount = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?)(k)?";
const thresholdBefore = new RegExp(
  "\\b(above|over|below|under|at least|at most)\\s*\\$?\\s*" + amount + "(?![\\d.%])",
  "i",
);
const thresholdAfter = new RegExp(
  "\\$?" + amount + "\\s+(?:or |and )?(above|higher|below|lower)\\b",
  "i",
);
const monthNumber = (name: string) => months.findIndex((m) => m.startsWith(name.toLowerCase())) + 1;

export function marketSearch(raw: string, now: number) {
  // Size is a trading term, independent of the underlying asset's price threshold.
  let q = normalizeMarketQuery(raw)
    .replace(
      /\b(?:put|bet|spend|invest)\s+\$?\d+(?:[.,]\d+)*(?:\s+dollars?)?\s+(?:on|in)\s+(?:it\b)?/g,
      " ",
    )
    .replace(/\bi (?:think|believe)\b/g, " ");
  q = q.replace(/\bat or (above|below)\b/g, "$1").replace(/(\d)\s+dollars?\b/g, "$1");
  const zone = q.match(zonePattern)?.[0];
  const format = zone?.startsWith("e") ? eastern : central;
  q = q.replace(zonePattern, " ");
  const today = calendar(now, format);
  let date: { year?: number; month: number; day: number } | null = null;
  let clock: { hour: number; minute: number } | null = null;
  let strike: { direction: string; value: number } | null = null;

  q = q
    .replace(/\b(20\d{2})-(\d{2})-(\d{2})\b/, (_, y, m, d) => {
      date = { year: +y, month: +m, day: +d };
      return " ";
    })
    .replace(monthDate, (_, m, d, y) => {
      date = { month: monthNumber(m), day: +d, ...(y && { year: +y }) };
      return " ";
    })
    .replace(monthEnd, (_, m, y) => {
      const month = monthNumber(m),
        year = y ? +y : today.year + Number(month < today.month);
      date = { month, year, day: new Date(Date.UTC(year, month, 0)).getUTCDate() };
      return " ";
    })
    .replace(/\b(today|tomorrow)\b/, (_, when) => {
      const day = new Date(
        Date.UTC(today.year, today.month - 1, today.day + Number(when === "tomorrow")),
      );
      date = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
      return " ";
    });
  q = q.replace(/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i, (_, h, m, period) => {
    clock = { hour: (+h % 12) + (period === "p" ? 12 : 0), minute: +(m ?? 0) };
    return " ";
  });
  if (clock && !date) date = today;
  q = q
    .replace(thresholdBefore, (_, dir, n, k) => {
      strike = {
        direction: /below|under|at most/.test(dir) ? "below" : "above",
        value: Number(n.replaceAll(",", "")) * (k ? 1000 : 1),
      };
      return " ";
    })
    .replace(thresholdAfter, (_, n, k, dir) => {
      strike = {
        direction: /below|lower/.test(dir) ? "below" : "above",
        value: Number(n.replaceAll(",", "")) * (k ? 1000 : 1),
      };
      return " ";
    });
  if (!strike)
    q = q.replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)(k)?\b/i, (_, n, k) => {
      strike = { direction: "", value: Number(n.replaceAll(",", "")) * (k ? 1000 : 1) };
      return " ";
    });
  const words = q
    .replace(
      /\b(?:find|show|pull up|please|me|which|the|a|an|market[s]?|contracts?|predictions?|for|at|on|in|of|by|will|finish(?:es)?|finishing|ends?|ending|expire[s]?|expiring|price|is|be)\b/g,
      " ",
    )
    .replace(/\b(?:fifteen|15)[ -]?(?:minutes?|mins?|m)\b/g, "15m")
    .replace(/\b(?:one|1)[ -]hour\b/g, "hourly")
    .replace(/\b(?:going|goes) (up|down)\b/g, "$1")
    .split(/\s+/)
    .map((w) => w.replace(/^[?,.]+|[?,.]+$/g, ""))
    .filter(Boolean);
  function matches(event: MarketEvent, contract: MarketContract) {
    if (date || clock) {
      const expiry = Date.parse(contract.expiry ?? "");
      if (!Number.isFinite(expiry) || expiry <= now) return false;
      const closing = calendar(expiry, format);
      if (
        date &&
        (date.month !== closing.month ||
          date.day !== closing.day ||
          (date.year && date.year !== closing.year))
      )
        return false;
      if (clock && (clock.hour !== closing.hour || clock.minute !== closing.minute)) return false;
    }
    if (
      strike &&
      (!contract.strike ||
        contract.strike.type === "reference" ||
        (strike.direction && contract.strike.type !== strike.direction) ||
        contract.strike.value !== strike.value)
    )
      return false;
    const text = [
      event.title,
      event.ticker,
      event.category,
      event.series,
      ...(event.tags ?? []),
      contract.symbol,
      contract.label,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => {
      if (w === "hourly") {
        if (/\bhourly\b/.test(text)) return true;
        const duration = Date.parse(contract.expiry ?? "") - Date.parse(event.start_time ?? "");
        return Number.isFinite(duration)
          ? duration === 3600000
          : /1h$/i.test(event.series ?? "") && !/\b(daily|weekly|monthly)\b/.test(text);
      }
      if (w === "up" || w === "down")
        return ["up", "down"].includes(contract.label?.toLowerCase() ?? "") || text.includes(w);
      return text.includes(w);
    });
  }
  return { matches, words, hasExpiry: Boolean(date || clock), hasStrike: Boolean(strike) };
}

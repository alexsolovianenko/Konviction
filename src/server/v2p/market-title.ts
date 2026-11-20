const easternClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
});
const austinClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
});
const austinDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", month: "short", day: "numeric",
});

// Gemini recurring markets embed the Eastern closing clock in their name.
// Match it against the actual expiry before changing any contract wording.
export function marketTitle(title: string, expiry: unknown): string {
  const at = typeof expiry === "string" ? Date.parse(expiry) : NaN;
  if (!Number.isFinite(at)) return title;
  return title.replace(/\b(?:(today at)\s+)?(1[0-2]|[1-9])(?::([0-5]\d))?\s*([ap])m\s+(?:est|edt|et|eastern(?: time)?)\b/gi,
    (original, today, hour, minute, period) => {
      const clock = hour + ":" + (minute ?? "00") + " " + period.toUpperCase() + "M";
      if (clock !== easternClock.format(at)) return original;
      const date = today ? austinDate.format(at) + " at " : "";
      return date + austinClock.format(at) + " Central time";
    });
}

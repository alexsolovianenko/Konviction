export function cents(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return "—";
  const c = Math.round(Number(p) * 1000) / 10;
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)}¢`;
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return String(n);
}

export function hms(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortHash(h: string | null | undefined, n = 8): string {
  if (!h) return "—";
  return h.length <= n * 2 ? h : `${h.slice(0, n)}…${h.slice(-4)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function countdown(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

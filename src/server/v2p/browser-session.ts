// Verified browser voice sessions.
// The server mints a session token only together with an ElevenLabs signed URL for our private
// agent. The token is HMAC-SHA256 signed with VOICE_SESSION_SECRET, lives only in browser memory,
// and is never visible to the language model (client tools never receive it).
import { env, safeEqual } from "./util";

export const SESSION_TTL_MS = 60 * 60 * 1000;
export const SESSION_PREFIX = "session:";
export type SessionClaims = { v: 1; sid: string; cid: string | null; iat: number; exp: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionSecret(): string | null {
  const s = env("VOICE_SESSION_SECRET") ?? "";
  return s.length >= 32 ? s : null;
}
export const sessionConfigured = () => sessionSecret() !== null;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("v2p-voice-session." + data))));
}

export async function mintSessionToken(claims: SessionClaims): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("VOICE_SESSION_SECRET not configured");
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${body}.${await sign(body, secret)}`;
}

/** Returns the claims of a valid, unexpired token signed by this server, else null. */
export async function verifySessionToken(token: string | null | undefined, now = Date.now()): Promise<SessionClaims | null> {
  const secret = sessionSecret();
  if (!secret || typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(parts[1], await sign(parts[0], secret))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (c?.v !== 1 || typeof c.sid !== "string" || !UUID.test(c.sid)) return null;
    if (!Number.isFinite(c.exp) || now >= c.exp || !Number.isFinite(c.iat) || c.iat > now + 60_000) return null;
    return { v: 1, sid: c.sid, cid: typeof c.cid === "string" ? c.cid : null, iat: c.iat, exp: c.exp };
  } catch {
    return null;
  }
}

export type SignedUrl = { signed_url: string; conversation_id: string | null } | { error: string };

/** Ask ElevenLabs for a single-use signed WebSocket URL for our private agent. */
export async function fetchSignedUrl(fetchImpl: typeof fetch = fetch): Promise<SignedUrl> {
  const apiKey = env("ELEVENLABS_API_KEY");
  const agentId = env("ELEVENLABS_AGENT_ID");
  if (!apiKey || !agentId) return { error: "ElevenLabs agent is not configured." };
  const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url");
  url.searchParams.set("agent_id", agentId);
  url.searchParams.set("include_conversation_id", "true");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // redirect: "manual" — Cloudflare Workers throw on redirect: "error" (see gemini.ts).
    const res = await fetchImpl(url, { headers: { "xi-api-key": apiKey, Accept: "application/json" }, redirect: "manual", signal: ctrl.signal });
    if (!res.ok) {
      console.error(JSON.stringify({ event: "elevenlabs_signed_url_failed", status: res.status }));
      return { error: "ElevenLabs is unavailable right now." };
    }
    const data = await res.json();
    const signed = new URL(String(data?.signed_url ?? ""));
    if (signed.protocol !== "wss:" || !/(^|\.)elevenlabs\.io$/.test(signed.hostname)) return { error: "ElevenLabs returned an unexpected URL." };
    const cid = data?.conversation_id ?? signed.searchParams.get("conversation_id");
    return { signed_url: signed.toString(), conversation_id: typeof cid === "string" && cid ? cid.slice(0, 200) : null };
  } catch (e) {
    console.error(JSON.stringify({ event: "elevenlabs_signed_url_failed", error_name: (e as Error)?.name ?? null }));
    return { error: "ElevenLabs is unavailable right now." };
  } finally {
    clearTimeout(timer);
  }
}

// Reads call metadata by default. The explicit audio probe synthesizes one short word.
import { existsSync } from "node:fs";
for (const path of [".env", process.env.SERVER_ENV_FILE ?? "../UBC-Hackathon/.env"]) {
  if (existsSync(path)) process.loadEnvFile(path);
}
const id = process.env.ELEVENLABS_AGENT_ID;
const key = process.env.ELEVENLABS_API_KEY;
async function read(path) {
  const response = await fetch("https://api.elevenlabs.io/v1/convai/" + path, {
    headers: { "xi-api-key": key }, redirect: "error", signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = body.detail?.code ?? body.detail?.status;
    throw new Error(`HTTP ${response.status}${typeof code === "string" && /^\w+$/.test(code) ? " " + code : ""}`);
  }
  return response.json();
}
try {
  if (!key || !id) throw new Error("Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID.");
  let agent;
  try {
    agent = await read("agents/" + encodeURIComponent(id));
  } catch (error) {
    if (error.message.startsWith("HTTP 404")) {
      const visible = await read("agents?page_size=20");
      console.error("This key cannot see the configured agent. Agents visible to this key:", visible.agents.map(a => a.name).join(", ") || "none");
    }
    throw error;
  }
  console.log("Configured agent:", agent.name, id);
  const args = process.argv.slice(2);
  const probe = args.includes("--probe-audio");
  const positional = args.filter(arg => arg !== "--probe-audio");
  if (positional.length > 1) throw new Error("Supply at most one conversation ID.");
  if (probe) {
    // ElevenAgents sometimes hides account restrictions behind its generic close code.
    // The synthesis API can supply a specific provider error for the same workspace.
    const voice = agent.conversation_config?.tts?.voice_id;
    if (!voice) throw new Error("The configured agent has no voice ID.");
    const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voice), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hi.", model_id: "eleven_flash_v2_5" }),
    });
    if (response.ok) {
      console.log("Speech synthesis: received", (await response.arrayBuffer()).byteLength, "audio bytes.");
    } else {
      const body = await response.json().catch(() => ({}));
      const reason = body.detail?.status ?? body.detail?.code;
      console.log("Speech synthesis:", response.status,
        typeof reason === "string" && /^\w+$/.test(reason) ? reason : "unspecified provider error");
      if (reason === "detected_unusual_activity") console.log("ElevenLabs disabled free-tier access on this account. Contact ElevenLabs about the restriction.");
      process.exitCode = 1;
    }
  }
  const arg = positional[0];
  if (arg && !/^conv_[a-zA-Z0-9_-]+$/.test(arg)) throw new Error("Supply an ElevenLabs conversation ID, or omit it for the latest call.");
  const cid = arg ?? (await read("conversations?agent_id=" + encodeURIComponent(id) + "&page_size=1")).conversations[0]?.conversation_id;
  if (cid) {
    const call = await read("conversations/" + encodeURIComponent(cid));
    if (call.agent_id !== id) throw new Error("That call belongs to a different agent.");
    const m = call.metadata;
    console.log("Call:", cid, new Date(m.start_time_unix_secs * 1000).toISOString());
    console.log("Status:", call.status, "Duration:", m.call_duration_secs, "seconds");
    if (m.error) console.log("Provider diagnosis:", m.error.error_type, m.error.code, m.error.reason);
    if (call.status === "failed") process.exitCode = 1;
  } else console.log("No calls recorded for this agent.");
} catch (error) {
  console.error("Voice diagnostic:", error.message);
  process.exitCode = 1;
}

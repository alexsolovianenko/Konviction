// Read-only. This command never signs a call URL, opens a microphone, or submits orders.
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
  const arg = process.argv[2];
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

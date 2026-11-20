import { readFileSync } from "node:fs";

const key = process.env.ELEVENLABS_API_KEY,
  agent = process.env.ELEVENLABS_AGENT_ID,
  branch = process.env.ELEVENLABS_BRANCH_ID;
if (!key || !agent || !branch) throw Error("Set the existing agent, branch and API key.");
const base = "https://api.elevenlabs.io/v1/convai/";
async function api(path, method = "GET", body) {
  const r = await fetch(base + path, {
    method,
    redirect: "error",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw Error(method + " " + path.split("?")[0] + " HTTP " + r.status);
  return r.json();
}
const path = "agents/" + agent + "?branch_id=" + branch;
const live = await api(path),
  prior = live.conversation_config.agent.prompt;
const named = (await api("tools")).tools;
const confirm = named.find(
  (t) => prior.tool_ids.includes(t.id) && t.tool_config.name === "confirm_hosted_sandbox_buy",
)?.tool_config;
if (!confirm) throw Error("Existing production confirmation tool missing.");
const origin = new URL(confirm.api_schema.url).origin,
  secret = confirm.api_schema.request_headers["x-call-secret"];
if (!secret?.secret_id || !origin.startsWith("https://"))
  throw Error("Invalid existing webhook configuration.");
const clients = JSON.parse(readFileSync("agent/browser-client-tools.json")).tools;
const client = (n) => clients.find((t) => t.name === n).parameters;
const sys = confirm.api_schema.request_body_schema.properties;
const definitions = [];
for (const n of ["search_markets", "get_orderbook"]) {
  const { type, properties, required } = client(n);
  definitions.push({
    name: "phone_" + n,
    description: "On a Twilio call only. " + clients.find((t) => t.name === n).description,
    api_schema: {
      url: origin + "/api/public/market-tools/" + n,
      method: "GET",
      query_params_schema: { type, properties, required },
    },
  });
}
const forms = [
  [
    "authenticate",
    "authenticate",
    "Verify the caller using their current authenticator code. Speak any returned settlement only after success.",
    {
      code: {
        type: "string",
        description: "Six digits spoken by the caller, including leading zeros.",
      },
    },
    ["code"],
  ],
  [
    "get_positions",
    "positions",
    "Read the verified caller’s live Gemini Sandbox holdings.",
    {},
    [],
  ],
  [
    "prepare_trade",
    "prepare",
    "Prepare the caller’s requested order. Speak say verbatim and wait for explicit confirmation.",
    client("prepare_sandbox_buy").properties,
    client("prepare_sandbox_buy").required,
  ],
  [
    "confirm_trade",
    "confirm",
    "Submit the single prepared phone order only after its exact readback and separate explicit spoken confirmation.",
    { proposal_id: sys.proposal_id, history: sys.history },
    ["proposal_id", "history"],
  ],
];
for (const [name, route, description, props, required] of forms) {
  definitions.push({
    name: "phone_" + name,
    description: "On a Twilio call only. " + description,
    api_schema: {
      url: origin + "/api/public/phone/" + route,
      method: "POST",
      request_headers: { "x-call-secret": secret },
      request_body_schema: {
        type: "object",
        description: "Authenticated native telephone tool request.",
        properties: {
          conversation_id: sys.conversation_id,
          is_text_only: sys.is_text_only,
          ...props,
        },
        required: ["conversation_id", "is_text_only", ...required],
      },
    },
  });
}
const ids = [];
for (const definition of definitions) {
  const matches = named.filter((t) => t.tool_config.name === definition.name);
  if (matches.length > 1) throw Error("Duplicate tool " + definition.name);
  const tool_config = {
    type: "webhook",
    pre_tool_speech: "off",
    response_timeout_secs: 30,
    follow_redirects: false,
    ...definition,
  };
  const existing = matches[0];
  const result = await api(
    existing ? "tools/" + existing.id : "tools",
    existing ? "PATCH" : "POST",
    { tool_config },
  );
  ids.push(existing?.id ?? result.id);
}
const current = (await api(path)).conversation_config.agent.prompt;
const section = readFileSync("agent/phone-instructions.md", "utf8").trim();
if (current.prompt.includes("\nNative telephone calls\n") && !current.prompt.includes(section))
  throw Error("Existing phone instructions changed. Reconcile before publishing.");
const prompt = current.prompt.includes(section)
  ? current.prompt
  : current.prompt.trimEnd() + "\n\n" + section;
const tool_ids = [...new Set([...current.tool_ids, ...ids])];
await api(path, "PATCH", {
  conversation_config: { agent: { prompt: { prompt, tool_ids } } },
  platform_settings: {
    overrides: { conversation_config_override: { agent: { first_message: true } } },
  },
});
const after = await api(path);
if (
  after.conversation_config.agent.prompt.prompt !== prompt ||
  !tool_ids.every((id) => after.conversation_config.agent.prompt.tool_ids.includes(id))
)
  throw Error("Publication mismatch");
console.log("Verified phone tools and existing agent branch", after.version_id);

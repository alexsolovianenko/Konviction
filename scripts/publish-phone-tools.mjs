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
const phoneBranch = process.env.ELEVENLABS_PHONE_BRANCH_ID;
if (!phoneBranch || phoneBranch === branch) throw Error("Set a separate ELEVENLABS_PHONE_BRANCH_ID.");
const phonePath = "agents/" + agent + "?branch_id=" + encodeURIComponent(phoneBranch);
await api(phonePath);
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
// ElevenLabs webhook literal schemas accept a subset of browser JSON Schema.
const client = (n) => {
  const { properties, required } = clients.find((t) => t.name === n).parameters;
  return {
    required,
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, p]) => [
        name,
        { type: p.type, description: p.description, ...(p.enum && { enum: p.enum }) },
      ]),
    ),
  };
};
const sys = confirm.api_schema.request_body_schema.properties;
const definitions = [];
for (const n of ["search_markets", "get_orderbook"]) {
  const { properties, required } = client(n);
  definitions.push({
    name: "phone_" + n,
    description: "On a Twilio call only. " + clients.find((t) => t.name === n).description,
    api_schema: {
      url: origin + "/api/public/market-tools/" + n,
      method: "GET",
      query_params_schema: { properties, required },
    },
  });
}
const forms = [
  ["get_settlement", "settlement", "Read only the settlement attached to this outbound callback after the recipient asks to hear it.", {}, []],
  [
    "get_positions",
    "positions",
    "Read the public sandbox demo holdings.",
    {},
    [],
  ],
  [
    "prepare_demo_trade",
    "prepare",
    "Prepare the order once, speak say verbatim and wait for explicit confirmation. If the service fails, stop retrying.",
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
const quoteId = { type: "string", description: "Exact quote_id returned by the telephone research quote." };
const symbol = { type: "string", description: "Exact contract symbol returned by market search." };
const ticker = { type: "string", description: "Exact event ticker returned by market search." };
forms.push(
  ["request_research_quote", "research-quote", "Get an unpaid research quote for the selected market. Speak say exactly.",
    { event_ticker: ticker, contract_symbol: symbol, timeframe: { type: "string", enum: ["5m", "15m", "1h", "24h"], description: "Optional requested research window." } }, ["event_ticker", "contract_symbol"]],
  ["confirm_research", "research-confirm", "Purchase the quoted research only after exact readback and clear approval.",
    { quote_id: quoteId, history: sys.history }, ["quote_id", "history"]],
  ["get_research_result", "research-result", "Read the current research result without starting another payment.", { quote_id: quoteId }, ["quote_id"]],
  ["order_result", "order-result", "Read the recorded result for this call's proposal.", { proposal_id: sys.proposal_id }, ["proposal_id"]],
  ["build_combo", "combo", "Build a combo from the caller's selected prediction legs.", {
    legs: { type: "array", description: "Two to six selected contracts.", items: { type: "object", description: "One selected leg.",
      properties: { event_ticker: ticker, contract_symbol: symbol, outcome: { type: "string", description: "Caller’s chosen outcome.", enum: ["yes", "no"] } },
      required: ["event_ticker", "contract_symbol", "outcome"] } } }, ["legs"]]
);
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
    response_timeout_secs: definition.name === "phone_confirm_research" ? 60 : 30,
    follow_redirects: false,
    ...definition,
  };
  const existing = matches[0];
  if (existing && prior.tool_ids.includes(existing.id)) {
    if (existing.tool_config.type !== "webhook" || existing.tool_config.api_schema.url !== definition.api_schema.url)
      throw Error("Unexpected existing telephone tool " + definition.name);
    ids.push(existing.id);
    continue;
  }
  const result = await api(existing ? "tools/" + existing.id : "tools", existing ? "PATCH" : "POST", { tool_config });
  ids.push(existing?.id ?? result.id);
}
const prompt = readFileSync("agent/912-phone.md", "utf8").trim();
const { voice_id, speed } = live.conversation_config.tts;
const first_message = live.conversation_config.agent.first_message;
await api(phonePath, "PATCH", { conversation_config: {
  tts: { voice_id, speed, supported_voices: [] },
  agent: { first_message, prompt: { prompt, tool_ids: ids } }
} });
const after = (await api(phonePath)).conversation_config;
if (after.agent.prompt.prompt !== prompt || after.tts.voice_id !== voice_id ||
    after.agent.first_message !== first_message || after.agent.prompt.tool_ids.length !== ids.length ||
    !ids.every(id => after.agent.prompt.tool_ids.includes(id)))
  throw Error("Telephone publication mismatch.");
console.log("Verified dedicated branch, regular voice, greeting and", ids.length, "telephone webhooks.");

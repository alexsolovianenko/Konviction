// Run from a trusted shell with server credentials in the environment.
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_BRANCH_ID,
  TWILIO_PHONE_NUMBER,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;
if (
  ![
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    ELEVENLABS_BRANCH_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
  ].every(Boolean) ||
  !/^\+[1-9]\d{7,14}$/.test(TWILIO_PHONE_NUMBER ?? "")
)
  throw Error(
    "Set the ElevenLabs agent, branch, API key and Twilio number, account SID and auth token.",
  );
async function api(path, method = "GET", body) {
  const response = await fetch("https://api.elevenlabs.io/v1/convai/" + path, {
    method,
    redirect: "error",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (!response.ok)
    throw Error(
      "ElevenLabs " + method + " " + path.split("/")[0] + " returned HTTP " + response.status,
    );
  return response.json();
}
const numberUrl = new URL(
  "https://api.twilio.com/2010-04-01/Accounts/" +
    encodeURIComponent(TWILIO_ACCOUNT_SID) +
    "/IncomingPhoneNumbers.json",
);
numberUrl.searchParams.set("PhoneNumber", TWILIO_PHONE_NUMBER);
const response = await fetch(numberUrl, {
  redirect: "error",
  headers: {
    Authorization:
      "Basic " + Buffer.from(TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN).toString("base64"),
  },
});
if (!response.ok) throw Error("Twilio ownership check returned HTTP " + response.status);
const owned = (await response.json()).incoming_phone_numbers?.find(
  (n) => n.phone_number === TWILIO_PHONE_NUMBER && n.capabilities?.voice,
);
if (!owned) throw Error("No matching voice-capable number in this Twilio account.");
await api("agents/" + ELEVENLABS_AGENT_ID + "/branches/" + ELEVENLABS_BRANCH_ID);
let number = (await api("phone-numbers")).find((n) => n.phone_number === TWILIO_PHONE_NUMBER);
if (number?.assigned_agent && number.assigned_agent.agent_id !== ELEVENLABS_AGENT_ID)
  throw Error("The number belongs to a different ElevenLabs agent.");
if (!number)
  number = await api("phone-numbers", "POST", {
    provider: "twilio",
    phone_number: TWILIO_PHONE_NUMBER,
    label: "Konviction",
    agent_id: ELEVENLABS_AGENT_ID,
    sid: TWILIO_ACCOUNT_SID,
    token: TWILIO_AUTH_TOKEN,
    enable_sms: false,
  });
if (!number.phone_number_id) throw Error("Import did not return a phone number ID.");
const path = "phone-numbers/" + encodeURIComponent(number.phone_number_id);
if (number.assigned_agent?.branch_id !== ELEVENLABS_BRANCH_ID)
  await api(path, "PATCH", { agent_id: ELEVENLABS_AGENT_ID, branch_id: ELEVENLABS_BRANCH_ID });
const result = await api(path);
if (
  result.assigned_agent?.agent_id !== ELEVENLABS_AGENT_ID ||
  result.assigned_agent?.branch_id !== ELEVENLABS_BRANCH_ID
)
  throw Error("Could not verify the agent and branch assignment.");
console.log(
  "Verified native Twilio assignment",
  number.phone_number_id,
  "inbound",
  result.supports_inbound,
  "outbound",
  result.supports_outbound,
);

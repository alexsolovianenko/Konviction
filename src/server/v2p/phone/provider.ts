export async function eleven(path: string, body?: unknown) {
  const key = process.env["ELEVENLABS_API_KEY"];
  if (!key) throw Error("Voice provider unavailable");
  const r = await fetch("https://api.elevenlabs.io/v1/convai/" + path, {
    method: body ? "POST" : "GET",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error("Voice provider HTTP " + r.status);
  return r.json();
}

export async function nativeCall(cid: string) {
  if (!/^conv_[a-z0-9]{1,80}$/i.test(cid)) return null;
  const c = await eleven("conversations/" + cid);
  const p = c.metadata?.phone_call;
  if (
    c.conversation_id !== cid ||
    c.agent_id !== process.env["ELEVENLABS_AGENT_ID"] ||
    c.branch_id !== process.env["ELEVENLABS_BRANCH_ID"] ||
    c.status !== "in-progress" ||
    !p ||
    p.type !== "twilio" ||
    !process.env["ELEVENLABS_PHONE_NUMBER_ID"] ||
    p.phone_number_id !== process.env["ELEVENLABS_PHONE_NUMBER_ID"]
  )
    return null;
  return {
    phone: p.external_number as string,
    direction: p.direction as string,
    notice: c.conversation_initiation_client_data?.dynamic_variables?.settlement_ref,
  };
}

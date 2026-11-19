export function phoneConfig(env = process.env) {
  const origin = env.PHONE_PUBLIC_ORIGIN;
  const account = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.PHONE_OWNER_NUMBER;
  const to = env.TWILIO_FROM_NUMBER;
  const e164 = /^\+[1-9]\d{7,14}$/;
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    origin !== url.origin ||
    !/^AC[a-f0-9]{32}$/i.test(account) ||
    !token ||
    !e164.test(from) ||
    !e164.test(to)
  )
    throw Error("Invalid inbound phone configuration.");
  return { origin, account, token, from, to };
}

import { QueueClient } from "@vercel/queue";

const queue = new QueueClient({ region: "iad1" });
const consume = queue.handleCallback(
  async () => {
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const secret = process.env.CRON_SECRET;
    if (!host || !secret) throw Error("Settlement watcher configuration missing");
    const r = await fetch("https://" + host + "/api/public/phone/watch", {
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer " + secret },
      signal: AbortSignal.timeout(100000),
    });
    if (!r.ok) throw Error("Settlement watch failed: " + r.status);
    const result = await r.json();
    console.info("Settlement watch completed", { accounts: result.accounts });
  },
  { retry: () => ({ afterSeconds: 3 }) },
);

// Build Output functions receive Node HTTP objects without framework helpers.
export default async function handler(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const response = await consume(
    new Request("https://queue.internal/settlement-watch", {
      method: req.method,
      headers: req.headers,
      ...(req.method === "POST" && { body: Buffer.concat(chunks) }),
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

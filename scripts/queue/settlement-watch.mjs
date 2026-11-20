import { QueueClient } from "@vercel/queue";

const queue = new QueueClient({ region: "iad1", deploymentId: null });
export default queue.handleNodeCallback(
  async () => {
    // Unpinned messages follow the production alias on subsequent deployments.
    const now = Date.now();
    const next = Math.floor(now / 60000) + 1;
    await queue.send(
      "konviction-settlements",
      {},
      {
        idempotencyKey: "minute-" + next,
        delaySeconds: Math.ceil((next * 60000 - now) / 1000),
      },
    );
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

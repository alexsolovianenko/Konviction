import { createFileRoute } from "@tanstack/react-router";

// Dynamic import keeps the research wallet and the QuickNode x402 SDK out of the client bundle.
const load = () => import("@/server/v2p/quicknode-research/handler");

export const Route = createFileRoute("/api/public/quicknode-research/$action")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        (await load()).handleQuicknodeResearch(request, params.action),
      POST: async ({ request, params }) =>
        (await load()).handleQuicknodeResearch(request, params.action),
    },
  },
});

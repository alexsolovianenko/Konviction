import { createFileRoute } from "@tanstack/react-router";

// Dynamic import keeps the research wallet and viem out of the client bundle.
const load = () => import("@/server/v2p/arc-research/handler");

export const Route = createFileRoute("/api/public/arc-research/$action")({
  server: {
    handlers: {
      GET: async ({ request, params }) => (await load()).handleArcResearch(request, params.action),
      POST: async ({ request, params }) => (await load()).handleArcResearch(request, params.action),
    },
  },
});

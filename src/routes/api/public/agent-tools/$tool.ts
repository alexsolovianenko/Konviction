import { createFileRoute } from "@tanstack/react-router";

const load = () => import("@/server/v2p/agent-tools");

export const Route = createFileRoute("/api/public/agent-tools/$tool")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => (await load()).handleAgentTools(request),
      POST: async ({ request }) => (await load()).handleAgentTools(request),
    },
  },
});

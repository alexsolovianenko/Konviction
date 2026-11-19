import { createFileRoute } from "@tanstack/react-router";

const load = () => import("@/server/v2p/dashboard-state");

export const Route = createFileRoute("/api/public/dashboard-state")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => (await load()).handleDashboardState(request),
      GET: async ({ request }) => (await load()).handleDashboardState(request),
    },
  },
});

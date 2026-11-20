import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/phone/$action")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        (await import("@/server/v2p/phone/tools")).phoneTool(request, params.action),
      GET: async ({ request, params }) =>
        params.action === "settlements"
          ? (await import("@/server/v2p/phone/settlements")).checkSettlements(request)
          : new Response(null, { status: 404 }),
    },
  },
});

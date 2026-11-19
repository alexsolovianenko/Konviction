import { createFileRoute } from "@tanstack/react-router";

// Dynamic import keeps server code (Gemini signing, Supabase service role) out of the client bundle.
const load = () => import("@/server/v2p/browser-trading");

export const Route = createFileRoute("/api/public/browser-trading/$action")({
  server: {
    handlers: {
      GET: async ({ request, params }) => (await load()).handleBrowserTrading(request, params.action),
      POST: async ({ request, params }) => (await load()).handleBrowserTrading(request, params.action),
    },
  },
});

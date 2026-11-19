import { createFileRoute } from "@tanstack/react-router";

const load = () => import("@/server/v2p/el-init");

export const Route = createFileRoute("/api/public/el-init")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => (await load()).handleElInit(request),
      POST: async ({ request }) => (await load()).handleElInit(request),
    },
  },
});

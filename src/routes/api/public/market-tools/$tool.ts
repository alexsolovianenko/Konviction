import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/market-tools/$tool")({
  server: { handlers: { GET: async ({ request, params }) => {
    const { marketTool } = await import("@/server/v2p/market-tools");
    const response = await marketTool(params.tool, new URL(request.url).searchParams);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } } }
});

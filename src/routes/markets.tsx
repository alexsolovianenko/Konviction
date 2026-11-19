import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { MarketsView } from "@/components/console/Console";

export const Route = createFileRoute("/markets")({
  head: () => ({
    meta: [
      { title: "Markets · Voice-to-Predict" },
      { name: "description", content: "Active prediction contracts listed on Gemini Sandbox." },
    ],
  }),
  component: () => <ClientOnly><MarketsView /></ClientOnly>,
});

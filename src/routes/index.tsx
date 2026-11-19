import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/pages/Dashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Voice-to-Predict — Talk to the market" },
      { name: "description", content: "Search Gemini Sandbox prediction markets, request fresh contract quotes and capture intents by voice." },
      { property: "og:title", content: "Voice-to-Predict — Talk to the market" },
      { property: "og:description", content: "Browser voice, sandbox quotes, positions and receipts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => <ClientOnly><Dashboard /></ClientOnly>,
});

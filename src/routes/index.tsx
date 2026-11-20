import { createFileRoute } from "@tanstack/react-router";
import { Home } from "@/pages/Home";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Call Mommy — Voice" },
      { name: "description", content: "Search Gemini Sandbox prediction markets, request fresh contract quotes and capture intents by voice." },
      { property: "og:title", content: "Call Mommy — Voice" },
      { property: "og:description", content: "Browser voice, sandbox quotes, positions and receipts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

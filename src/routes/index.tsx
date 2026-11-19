import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { Console } from "@/components/console/Console";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Voice-to-Predict — Live Console" },
      { name: "description", content: "Search Gemini Sandbox prediction markets, request fresh contract quotes and capture intents by voice." },
      { property: "og:title", content: "Voice-to-Predict — Live Console" },
      { property: "og:description", content: "Browser voice, sandbox quotes, positions and receipts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ClientOnly fallback={<div className="flex min-h-screen items-center justify-center text-muted-foreground">Waiting for backend…</div>}>
      <Console />
    </ClientOnly>
  );
}

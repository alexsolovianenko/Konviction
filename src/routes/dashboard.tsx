import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { OverviewView } from "@/components/console/Console";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Account · Call Mommy" },
      { name: "description", content: "Gemini Sandbox account, voice activity, trades, positions and receipts." },
    ],
  }),
  component: () => <ClientOnly><OverviewView /></ClientOnly>,
});

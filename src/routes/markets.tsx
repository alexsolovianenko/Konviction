import { createFileRoute } from "@tanstack/react-router";
import { MarketWorkspace } from "@/pages/MarketWorkspace";

// Kept for existing links: the market listing is the home view.
export const Route = createFileRoute("/markets")({
  head: () => ({ meta: [{ title: "Prediction markets · Call Mommy" }] }),
  component: MarketWorkspace,
});

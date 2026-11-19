import { createFileRoute } from "@tanstack/react-router";
import { MarketWorkspace } from "@/pages/Home";

// Kept for existing links: the market listing is the home view.
export const Route = createFileRoute("/markets")({
  head: () => ({ meta: [{ title: "Prediction markets · Voice-to-Predict" }] }),
  component: MarketWorkspace,
});

import { createFileRoute } from "@tanstack/react-router";
import { PrivatePortfolio } from "../components/console/PrivatePortfolio";
import { PageHeader } from "../components/console/ui";

export const Route = createFileRoute("/open-trades")({
  head: () => ({ meta: [{ title: "Private trades · Voice-to-Predict" }] }),
  component: OpenTrades,
});

function OpenTrades() {
  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <PageHeader title="Private trades" lead="Unlock sandbox orders, fills, and positions with your approval PIN." />
      <PrivatePortfolio />
    </div>
  );
}

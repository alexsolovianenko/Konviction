import { createFileRoute } from "@tanstack/react-router";
import { Home } from "@/pages/Home";

// Kept for existing links: the voice workspace is the home view.
export const Route = createFileRoute("/voice")({
  head: () => ({ meta: [{ title: "Voice workspace · Call Mommy" }] }),
  component: Home,
});

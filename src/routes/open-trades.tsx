import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/open-trades")({
  beforeLoad: () => { throw redirect({ to: "/dashboard", replace: true }); },
});

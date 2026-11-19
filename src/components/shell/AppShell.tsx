import { ClientOnly, Link, useLocation } from "@tanstack/react-router";
import { House, AudioLines, ChartCandlestick, LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";
import { useDashboardState, useNow } from "../console/Console";
import { StatusBubble } from "../voice/StatusBubble";
import { VoiceProvider, useVoice } from "../voice/VoiceProvider";

const nav = [
  { to: "/", label: "Home", icon: House },
  { to: "/markets", label: "Markets", icon: ChartCandlestick },
  { to: "/dashboard", label: "Account", icon: LayoutDashboard },
] as const;

function FeedStatus() {
  const now = useNow();
  const q = useDashboardState();
  const age = q.dataUpdatedAt ? Math.max(0, Math.floor((now - q.dataUpdatedAt) / 1000)) : null;
  const stale = age === null || age > 10;
  return (
    <span className="tnum flex items-center gap-1.5">
      <span className={"size-1.5 rounded-full " + (stale ? "bg-destructive" : "bg-success")} aria-hidden />
      {age === null ? "No update yet" : `Updated ${age}s ago`}
    </span>
  );
}

// Shown on other views when a voice proposal is waiting, since approval lives on the Markets view.
function ProposalNotice({ path }: { path: string }) {
  const { view } = useVoice();
  if (!view.proposal || path === "/" || path === "/voice" || path === "/markets") return null;
  return (
    <Link to="/" className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-primary bg-primary-soft px-3 py-2 text-sm">
      <span className="truncate">A sandbox buy proposal is waiting for your review.</span>
      <span className="shrink-0 font-medium text-accent-foreground">Review</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useLocation({ select: (location) => location.pathname });
  const home = path === "/" || path === "/voice";
  const active = (to: string) => (to === "/" ? ["/", "/voice"].includes(path) : path.startsWith(to));
  return (
    <VoiceProvider>
      <div data-voice-home={home} className="min-h-dvh">
        <header className="workspace-bar">
          <Link to="/" className="workspace-brand">
            <AudioLines aria-hidden="true" /> Voice-to-Predict
          </Link>
          <nav aria-label="Primary" className="workspace-dock">
            {nav.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} aria-current={active(to) ? "page" : undefined}>
                <Icon size={18} aria-hidden="true" />{label}
              </Link>
            ))}
          </nav>
          <div className="workspace-feed">
            <span>Gemini Sandbox · test funds</span>
            <ClientOnly><FeedStatus /></ClientOnly>
          </div>
        </header>

        <div className="flex min-w-0 flex-col">
          {!home && <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
            <div className="flex h-12 items-center gap-3 px-4 lg:px-8">

              <div className="min-w-0 flex-1"><StatusBubble /></div>
            </div>
          </header>}
          <main className="w-full max-w-[84rem] flex-1 px-4 pb-24 pt-6 lg:px-8 lg:pb-12 lg:pt-8">
            <ProposalNotice path={path} />
            {children}
          </main>
        </div>


      </div>
    </VoiceProvider>
  );
}

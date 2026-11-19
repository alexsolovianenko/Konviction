import { ClientOnly, Link, useLocation } from "@tanstack/react-router";
import { House, AudioLines, ChartCandlestick, LayoutDashboard, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { useDashboardState, useNow } from "../console/Console";
import { StatusBubble } from "../voice/StatusBubble";
import { VoiceProvider, useVoice } from "../voice/VoiceProvider";

const nav = [
  { to: "/", label: "Home", icon: House },
  { to: "/markets", label: "Markets", icon: ChartCandlestick },
  { to: "/dashboard", label: "Account", icon: LayoutDashboard },
  { to: "/open-trades", label: "Private trades", icon: LockKeyhole },
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
      <div data-voice-home={home} className="min-h-dvh lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-sidebar px-2 py-3 lg:flex">
          <Link to="/" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-raised">
            <span className="grid size-5 place-items-center rounded bg-primary text-primary-foreground">
              <AudioLines className="size-3.5" aria-hidden />
            </span>
            Voice-to-Predict
          </Link>
          <nav aria-label="Primary" className="mt-4 flex flex-col gap-px">
            {nav.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                aria-current={active(to) ? "page" : undefined}
                className={"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-raised " + (active(to) ? "bg-raised font-medium text-foreground" : "text-subtle")}
              >
                <Icon className="size-4 text-muted-foreground" aria-hidden /> {label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto space-y-1 px-2 text-xs text-muted-foreground">
            <ClientOnly><FeedStatus /></ClientOnly>
            <p>Gemini Sandbox · test funds</p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          {!home && <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
            <div className="flex h-12 items-center gap-3 px-4 lg:px-8">
              <Link to="/" aria-label="Voice-to-Predict home" className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground lg:hidden">
                <AudioLines className="size-4" aria-hidden />
              </Link>
              <div className="min-w-0 flex-1"><StatusBubble /></div>
            </div>
          </header>}
          <main className="w-full max-w-[84rem] flex-1 px-4 pb-24 pt-6 lg:px-8 lg:pb-12 lg:pt-8">
            <ProposalNotice path={path} />
            {children}
          </main>
        </div>

        <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-sidebar pb-[env(safe-area-inset-bottom)] lg:hidden">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              aria-current={active(to) ? "page" : undefined}
              className={"flex min-w-0 flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium " + (active(to) ? "text-foreground" : "text-muted-foreground")}
            >
              <Icon className={"size-5 " + (active(to) ? "text-accent-foreground" : "")} aria-hidden />
              <span className="truncate">{label}</span>
            </Link>
          ))}
        </nav>
      </div>
    </VoiceProvider>
  );
}

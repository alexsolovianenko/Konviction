import { ClientOnly, Link, useLocation } from "@tanstack/react-router";
import { AudioLines, ChartCandlestick, LayoutDashboard, LockKeyhole, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useDashboardState, useNow } from "../console/Console";
import { Pill } from "../console/ui";
import { StatusBubble } from "../voice/StatusBubble";
import { VoiceProvider, useVoice } from "../voice/VoiceProvider";

const nav = [
  { to: "/", label: "Voice", icon: AudioLines },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/markets", label: "Markets", icon: ChartCandlestick },
  { to: "/open-trades", label: "Private trades", icon: LockKeyhole },
] as const;

function Brand() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="Voice-to-Predict home">
      <span className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground">
        <AudioLines className="size-5" aria-hidden />
      </span>
      <span className="hidden text-[1.05rem] font-semibold tracking-tight xl:inline">Voice-to-Predict</span>
    </Link>
  );
}

function FeedStatus() {
  const now = useNow();
  const q = useDashboardState();
  const age = q.dataUpdatedAt ? Math.max(0, Math.floor((now - q.dataUpdatedAt) / 1000)) : null;
  const stale = age === null || age > 10;
  return (
    <div className="flex items-center gap-1.5">
      {q.data && <Pill tone={q.data.execution_enabled ? "success" : "muted"} className="hidden 2xl:inline-flex">Phone execution {q.data.execution_enabled ? "on" : "off"}</Pill>}
      <Pill tone={stale ? "danger" : "muted"}>
        <span className={"size-1.5 rounded-full " + (stale ? "bg-destructive" : "bg-success")} aria-hidden />
        {age === null ? "No update yet" : `Updated ${age}s ago`}
      </Pill>
    </div>
  );
}

// Shown on other views when a voice proposal is waiting, since approval lives on the Voice view.
function ProposalNotice({ path }: { path: string }) {
  const { view } = useVoice();
  if (!view.proposal || path === "/" || path === "/voice") return null;
  return (
    <Link to="/" className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-primary/40 bg-primary-soft px-4 py-3 text-sm font-medium">
      <span className="flex min-w-0 items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">A sandbox buy proposal is waiting for your review.</span>
      </span>
      <span className="shrink-0 font-semibold text-primary">Review</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = useLocation({ select: (location) => location.pathname });
  const active = (to: string) => (to === "/" ? path === "/" || path === "/voice" : path.startsWith(to));
  return (
    <VoiceProvider>
      <div className="flex min-h-dvh flex-col">
        <p className="bg-canvas px-4 py-2 text-center text-xs font-medium text-muted-foreground sm:text-sm">
          <span className="font-semibold text-foreground">Gemini Sandbox · test funds.</span> Sandbox prices are not real market prices.
        </p>
        <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-[4.25rem] max-w-[90rem] items-center gap-3 px-4 sm:px-6 lg:gap-5 lg:px-8">
            <Brand />
            <nav aria-label="Primary" className="hidden items-center lg:flex">
              {nav.map(({ to, label }) => (
                <Link
                  key={to}
                  to={to}
                  aria-current={active(to) ? "page" : undefined}
                  className={"relative whitespace-nowrap rounded-full px-4 py-2.5 text-[0.95rem] font-semibold transition-colors hover:bg-secondary " + (active(to) ? "text-primary" : "text-foreground")}
                >
                  {label}
                  {active(to) && <span className="absolute inset-x-4 -bottom-[0.95rem] h-0.5 rounded-full bg-primary" aria-hidden />}
                </Link>
              ))}
            </nav>
            <div className="min-w-0 flex-1"><StatusBubble /></div>
            <div className="hidden shrink-0 md:block">
              <ClientOnly><FeedStatus /></ClientOnly>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-16 lg:pt-10">
          <ProposalNotice path={path} />
          {children}
        </main>

        <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              aria-current={active(to) ? "page" : undefined}
              className={"flex min-w-0 flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-semibold " + (active(to) ? "text-primary" : "text-muted-foreground")}
            >
              <span className={"grid h-7 w-12 place-items-center rounded-full " + (active(to) ? "bg-primary-soft" : "")}><Icon className="size-5" aria-hidden /></span>
              <span className="truncate">{label}</span>
            </Link>
          ))}
        </nav>
      </div>
    </VoiceProvider>
  );
}

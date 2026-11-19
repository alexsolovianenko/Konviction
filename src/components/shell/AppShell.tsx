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
    <Link to="/" className="flex items-center gap-2.5" aria-label="Voice-to-Predict home">
      <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
        <AudioLines className="size-5" aria-hidden />
      </span>
      <span className="text-[1.05rem] font-bold tracking-tight">
        Voice-to-<span className="text-primary">Predict</span>
      </span>
    </Link>
  );
}

function FeedStatus() {
  const now = useNow();
  const q = useDashboardState();
  const age = q.dataUpdatedAt ? Math.max(0, Math.floor((now - q.dataUpdatedAt) / 1000)) : null;
  const stale = age === null || age > 10;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {q.data && <Pill tone={q.data.execution_enabled ? "success" : "muted"}>Phone execution {q.data.execution_enabled ? "on" : "off"}</Pill>}
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
      <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-background px-3 py-5 lg:flex">
          <div className="px-3"><Brand /></div>
          <nav aria-label="Primary" className="mt-8 flex flex-col gap-1">
            {nav.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                aria-current={active(to) ? "page" : undefined}
                className={"flex items-center gap-3 rounded-full px-4 py-3 text-[0.95rem] font-semibold transition-colors " + (active(to) ? "bg-primary-soft text-primary" : "text-foreground hover:bg-muted")}
              >
                <Icon className="size-5" aria-hidden /> {label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto rounded-2xl bg-muted p-4 text-xs leading-relaxed text-muted-foreground">
            <Pill tone="warning" className="mb-2">Gemini Sandbox · test funds</Pill>
            <p>Sandbox prices are not real market prices. Nothing here is a recommendation.</p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
            <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
              <Link to="/" aria-label="Voice-to-Predict home" className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground lg:hidden">
                <AudioLines className="size-5" aria-hidden />
              </Link>
              <div className="min-w-0 flex-1"><StatusBubble /></div>
              <div className="hidden shrink-0 md:block">
                <ClientOnly><FeedStatus /></ClientOnly>
              </div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-10 lg:pt-7">
            <ProposalNotice path={path} />
            {children}
          </main>
        </div>

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

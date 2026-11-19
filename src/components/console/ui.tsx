import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "muted" | "violet" | "info" | "primary";
const toneCls: Record<Tone, string> = {
  success: "bg-success/12 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  violet: "bg-violet/10 text-violet",
  info: "bg-info/10 text-info",
  primary: "bg-primary-soft text-accent-foreground",
};

export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold", toneCls[tone], className)}>
      {children}
    </span>
  );
}

export function Panel({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel flex min-w-0 flex-col overflow-hidden", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pb-4 pt-6 sm:px-7">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Btn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="btn btn-chip">
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

export function PageHeader({ title, lead, right }: { title: string; lead: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
      <div className="min-w-0">
        <h1 className="display text-[2.5rem] sm:text-6xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground sm:text-lg">{lead}</p>
      </div>
      {right}
    </header>
  );
}

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  const text = useMemo(() => (typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)), [value]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="btn btn-chip"
      >{copied ? "Copied ✓" : "Copy"}</button>
      <pre className={cn("code-block", className)}>{text}</pre>
    </div>
  );
}

export const th = "px-5 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap sm:px-7";
export const td = "px-5 py-4 text-[0.95rem] tnum whitespace-nowrap sm:px-7";

import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "muted" | "violet" | "info" | "primary";
const toneCls: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  muted: "text-muted-foreground",
  violet: "text-violet",
  info: "text-info",
  primary: "text-accent-foreground",
};

// A coloured dot and a word: status without a box around it.
export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium", toneCls[tone], className)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

// A document section: quiet heading, hairline, content. No card.
export function Panel({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col", className)}>
      <header className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <h2 className="text-sm font-semibold">{title}</h2>
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
  return <div className="py-6 text-sm text-muted-foreground">{children}</div>;
}

export function PageHeader({ title, lead, right }: { title: string; lead?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{lead}</p>}
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

export const th = "";
export const td = "tnum whitespace-nowrap";

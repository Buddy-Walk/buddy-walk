import { OUTCOME_LABELS, type Outcome } from "#/lib/trials/outcome";
import type { NavigationMode } from "#/lib/trials/filters";
import type { ModuleStatus } from "#/lib/trials/modules";
import { cn } from "#/lib/utils";

const MODULE_STYLES: Record<ModuleStatus, string> = {
  pass: "bg-emerald-100 text-emerald-800",
  fail: "bg-red-100 text-red-800",
  na: "bg-zinc-100 text-zinc-500",
};

const MODULE_TEXT: Record<ModuleStatus, string> = { pass: "PASS", fail: "FAIL", na: "N/A" };

const badgeBase = "inline-block rounded-md px-2 py-0.5 text-xs font-bold whitespace-nowrap";

/** A module's status, or a custom label in the same colors. */
export function ModuleBadge({ status, label }: { status: ModuleStatus; label?: string }) {
  return (
    <span className={cn(badgeBase, MODULE_STYLES[status])}>{label ?? MODULE_TEXT[status]}</span>
  );
}

const GATE_STYLES: Record<NavigationMode, string> = {
  exact: "bg-blue-100 text-blue-800",
  approach: "bg-amber-100 text-amber-800",
  aligned: "bg-emerald-100 text-emerald-800",
  none: "bg-zinc-100 text-zinc-600",
};

export function GateBadge({ mode, label }: { mode: NavigationMode; label: string }) {
  return <span className={cn(badgeBase, "tracking-wide", GATE_STYLES[mode])}>{label}</span>;
}

const OUTCOME_DOTS: Record<Outcome, string> = {
  got_there: "bg-emerald-500",
  needed_retake: "bg-amber-500",
  would_not_get_there: "bg-red-500",
  unscored: "border-[1.5px] border-current bg-transparent",
};

/** The reviewer's outcome as a colored dot and label. */
export function OutcomeMark({ outcome }: { outcome: Outcome }) {
  return (
    <span
      className={cn(
        "flex items-baseline gap-2 leading-snug",
        outcome === "unscored" && "text-muted-foreground",
      )}
    >
      <span className={cn("size-2 shrink-0 -translate-y-px rounded-full", OUTCOME_DOTS[outcome])} />
      {outcome === "unscored" ? "Not scored" : OUTCOME_LABELS[outcome]}
    </span>
  );
}

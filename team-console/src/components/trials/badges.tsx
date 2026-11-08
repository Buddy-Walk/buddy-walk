import { OUTCOME_LABELS, type Outcome } from "#/lib/trials/outcome";
import type { NavigationMode } from "#/lib/trials/filters";
import type { ModuleStatus } from "#/lib/trials/modules";
import { cn } from "#/lib/utils";

const MODULE_STYLES: Record<ModuleStatus, string> = {
  pass: "bg-pass-soft text-pass",
  fail: "bg-fail-soft text-fail",
  na: "bg-na-soft text-na",
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
  exact: "bg-exact-soft text-exact",
  approach: "bg-warn-soft text-warn",
  aligned: "bg-pass-soft text-pass-text",
  none: "bg-na-soft text-na-text",
};

export function GateBadge({ mode, label }: { mode: NavigationMode; label: string }) {
  return <span className={cn(badgeBase, "tracking-wide", GATE_STYLES[mode])}>{label}</span>;
}

const OUTCOME_DOTS: Record<Outcome, string> = {
  got_there: "bg-mark-pass",
  needed_retake: "bg-mark-partial",
  would_not_get_there: "bg-destructive",
  unscored: "border-[1.5px] border-current bg-transparent",
};

/** The reviewer's outcome as a colored dot and label. */
export function OutcomeMark({ outcome }: { outcome: Outcome }) {
  return (
    <span
      className={cn(
        "flex items-baseline gap-2 leading-snug",
        outcome === "unscored" && "text-quiet",
      )}
    >
      <span className={cn("size-2 shrink-0 -translate-y-px rounded-full", OUTCOME_DOTS[outcome])} />
      {outcome === "unscored" ? "Not scored" : OUTCOME_LABELS[outcome]}
    </span>
  );
}

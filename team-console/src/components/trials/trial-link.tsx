import {
  Link,
  linkOptions,
  useMatch,
  useNavigate,
  type HistoryState,
} from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";

/**
 * The history state a newly opened Trial gets. From the list it is one detail
 * deep, and from a detail one deeper. A detail opened from a shared link has no
 * list behind it, so neither do the Trials opened from it, and Close replaces
 * them with the list instead of going back.
 */
function useDeeper() {
  const fromDetail = useMatch({ from: "/trials/$trialId", shouldThrow: false }) !== undefined;
  return (state: HistoryState): HistoryState => ({
    ...state,
    trialDepth: !fromDetail ? 1 : state.trialDepth === undefined ? undefined : state.trialDepth + 1,
  });
}

const trialLink = (
  trialId: string,
  hash: string | undefined,
  state: ReturnType<typeof useDeeper>,
) =>
  linkOptions({
    to: "/trials/$trialId",
    params: { trialId },
    search: true,
    hash,
    state,
    resetScroll: false,
  });

/**
 * Whether a click on a row should open it, like its View link. Controls in the
 * row keep their own behavior, and a click that ends a drag-selection is
 * ignored so text can be copied.
 */
export function clickOpensRow(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  if (target.closest("a, button, input, select, textarea, label, summary")) return false;
  return !String(window.getSelection());
}

/**
 * Opens a Trial over the list, keeping its filters and scroll position. Each
 * open adds a history entry, so browser back returns to where it opened from.
 */
export function useOpenTrial() {
  const navigate = useNavigate();
  const deeper = useDeeper();
  return (trialId: string) => navigate(trialLink(trialId, undefined, deeper));
}

export function TrialLink({
  trialId,
  hash,
  className,
  title,
  children,
}: {
  trialId: string;
  hash?: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const deeper = useDeeper();
  return (
    <Link {...trialLink(trialId, hash, deeper)} className={className} title={title}>
      {children}
    </Link>
  );
}

import { XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { cn } from "#/lib/utils";

const MAX_TOASTS = 4;
const TOAST_MS = 5000;
// Long enough for the closing animation below to finish.
const CLOSE_ANIMATION_MS = 200;

interface ToastContent {
  title: string;
  body: ReactNode;
  failed?: boolean;
  /** Gets a function that closes this toast. */
  action?: (close: () => void) => ReactNode;
}

interface ToastEntry extends ToastContent {
  id: number;
  open: boolean;
}

// Kept outside React, so a retry finishing after its row is gone can still report.
let toasts: ToastEntry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const NO_TOASTS: ToastEntry[] = [];

function publish(next: ToastEntry[]) {
  toasts = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function closeToast(id: number) {
  publish(toasts.map((toast) => (toast.id === id ? { ...toast, open: false } : toast)));
  setTimeout(() => publish(toasts.filter((toast) => toast.id !== id)), CLOSE_ANIMATION_MS);
}

export function showToast(content: ToastContent) {
  publish([...toasts, { ...content, id: nextId++, open: true }].slice(-MAX_TOASTS));
}

/**
 * Closes a toast after a few seconds. Each toast counts down on its own, and
 * starts over when the reader stops hovering it or focusing inside it, or comes
 * back to a tab that was hidden, so a result that arrives unseen is still read.
 */
function useCountdown(id: number) {
  const root = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const toast = root.current;
    if (!toast) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => clearTimeout(timer);
    const start = () => {
      stop();
      if (document.hidden || toast.matches(":hover") || toast.contains(document.activeElement)) {
        return;
      }
      timer = setTimeout(() => closeToast(id), TOAST_MS);
    };
    const focusOut = (event: FocusEvent) => {
      if (!toast.contains(event.relatedTarget as Node | null)) start();
    };
    toast.addEventListener("mouseenter", stop);
    toast.addEventListener("focusin", stop);
    toast.addEventListener("mouseleave", start);
    toast.addEventListener("focusout", focusOut);
    document.addEventListener("visibilitychange", start);
    start();
    return () => {
      stop();
      toast.removeEventListener("mouseenter", stop);
      toast.removeEventListener("focusin", stop);
      toast.removeEventListener("mouseleave", start);
      toast.removeEventListener("focusout", focusOut);
      document.removeEventListener("visibilitychange", start);
    };
  }, [id]);
  return root;
}

function ToastItem({ id, open, title, body, failed, action }: ToastEntry) {
  const root = useCountdown(id);
  return (
    <ToastPrimitive.Root
      ref={root}
      open={open}
      onOpenChange={(next) => {
        if (!next) closeToast(id);
      }}
      type={failed ? "foreground" : "background"}
      className={cn(
        "grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg border border-l-3 bg-popover py-3 pr-3 pl-3.5 text-popover-foreground shadow-lg",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        failed ? "border-red-300 border-l-red-600" : "border-violet-300 border-l-violet-500",
      )}
    >
      <ToastPrimitive.Title className="text-sm font-bold">{title}</ToastPrimitive.Title>
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground"
      >
        <XIcon aria-hidden className="size-4" />
      </ToastPrimitive.Close>
      <ToastPrimitive.Description asChild>
        <div className="col-span-full text-sm leading-snug text-muted-foreground">{body}</div>
      </ToastPrimitive.Description>
      {action && <div className="col-span-full mt-1.5">{action(() => closeToast(id))}</div>}
    </ToastPrimitive.Root>
  );
}

/** Shows toasts bottom right. Radix's own timer is off, since useCountdown keeps the time. */
export function Toaster() {
  const entries = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => NO_TOASTS,
  );
  return (
    <ToastPrimitive.Provider duration={Infinity} swipeDirection="right">
      {entries.map((entry) => (
        <ToastItem key={entry.id} {...entry} />
      ))}
      {/*
        Toasts must still work over a modal dialog, which turns off pointer events on the page and
        hides the rest of it from assistive tech, except anything with aria-live. Radix announces
        each toast itself, so "off" keeps it from being announced twice.
      */}
      <ToastPrimitive.Viewport
        aria-live="off"
        className="pointer-events-auto fixed right-4 bottom-4 z-[90] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2.5 outline-none"
      />
    </ToastPrimitive.Provider>
  );
}

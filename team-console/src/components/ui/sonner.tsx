import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      duration={5000}
      visibleToasts={4}
      expand
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "border-replay-line! border-l-3! border-l-replay! data-[type=error]:border-failure-line! data-[type=error]:border-l-destructive!",
        },
      }}
      // Modal dialogs turn off pointer events on the page, and toasts must still work over them.
      className="toaster group pointer-events-auto"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

/** For a modal dialog's onInteractOutside: using a toast shouldn't close the dialog under it. */
function keepOpenForToast(event: Event) {
  if ((event.target as Element).closest("[data-sonner-toaster]")) event.preventDefault();
}

export { keepOpenForToast, Toaster };

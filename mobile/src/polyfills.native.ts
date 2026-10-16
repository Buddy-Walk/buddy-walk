/**
 * Hermes has no browser `Event` global; some transitive deps reference it at load time.
 * Install a minimal stub before the rest of the app imports run.
 */
const g = globalThis as typeof globalThis & { Event?: typeof Event };

if (typeof g.Event === 'undefined') {
  class EventPolyfill {
    readonly type: string;
    bubbles = false;
    cancelable = false;
    defaultPrevented = false;

    /**
     * Initialize the minimal event type needed by dependencies that expect a browser-like Event on
     * native.
     */
    constructor(type: string) {
      this.type = type;
    }

    /** Record cancellation on the lightweight native event shim. */
    preventDefault(): void {
      this.defaultPrevented = true;
    }

    /** Preserve the Event interface where native consumers have no DOM propagation tree to stop. */
    stopPropagation(): void {}
    /**
     * Preserve the Event interface where native consumers have no immediate DOM propagation to
     * stop.
     */
    stopImmediatePropagation(): void {}
  }

  g.Event = EventPolyfill as unknown as typeof Event;
}

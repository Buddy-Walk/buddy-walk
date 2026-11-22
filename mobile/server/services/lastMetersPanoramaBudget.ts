export interface PanoramaSearchBudget {
  seen: Set<string>;
  deadline: number;
  /** Count started requests, including failures, without logging URLs or keys. */
  apiRequests: number;
  enforceDeadline?: boolean;
}

export function panoramaDeadlineReached(budget: Pick<PanoramaSearchBudget, "deadline">): boolean {
  return Date.now() >= budget.deadline;
}

export class PanoramaDeadlineError extends Error {
  readonly code = "PANORAMA_SEARCH_DEADLINE";
  constructor() { super("Panorama search reached its 45-second deadline."); }
}

/** Attribute a transport timeout to the shared deadline only when the deadline has actually elapsed. */
export function isSearchDeadline(error: unknown, budget: PanoramaSearchBudget): boolean {
  if (error instanceof PanoramaDeadlineError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return panoramaDeadlineReached(budget) && (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ERR_CANCELED");
}

/** A provider call that returned a request was started, even if its promise later rejects. */
export function startPanoramaRequest<T>(budget: PanoramaSearchBudget | undefined, start: () => PromiseLike<T>): Promise<T> {
  const request = start();
  if (budget) budget.apiRequests++;
  return Promise.resolve(request);
}

/** Bound an experimental vision request and cancel it even if the provider never settles. */
export async function withinEntranceBudget<T>(budget: PanoramaSearchBudget, work: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
  const timeoutMs = Math.min(8000, budget.deadline - Date.now());
  if (timeoutMs <= 0) throw new PanoramaDeadlineError();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(abort.signal, timeoutMs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = panoramaDeadlineReached(budget) ? new PanoramaDeadlineError()
            : Object.assign(new Error("Panorama request timed out."), { code: "PANORAMA_REQUEST_TIMEOUT" });
          reject(error);
          abort.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

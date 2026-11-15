/** Cancellation also bounds a misbehaving adapter that never settles its promise. */
export async function withinEntranceBudget<T>(deadline: number, work: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
  const timeoutMs = Math.min(8000, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error("entrance_timeout");
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(abort.signal, timeoutMs),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        abort.abort();
        reject(new Error("entrance_timeout"));
      }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

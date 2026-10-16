/** When true, companion routes use in-memory storage (no MongoDB required). */
export let useCompanionMemoryStore = false;

/** Switch companion sessions to the in-memory fallback selected during server startup. */
export function setCompanionMemoryStore(enabled: boolean): void {
  useCompanionMemoryStore = enabled;
}

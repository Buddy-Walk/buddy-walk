/**
 * Render's free tier spins down after ~15 min with no traffic. GitHub Actions
 * cron is often delayed by hours, so the server pings its own public URL while
 * it is awake to reset the idle timer.
 */
export function startRenderKeepAlive(): void {
  const baseUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
  if (!baseUrl) return;

  const intervalMs = Number(process.env.KEEP_ALIVE_INTERVAL_MS ?? 10 * 60 * 1000);
  const healthUrl = `${baseUrl}/api/health`;

  /** Probe the configured health URL with a timeout and log failures without stopping the API. */
  const ping = async (): Promise<void> => {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) {
        console.warn(`[keepalive] ${healthUrl} returned ${res.status}`);
      }
    } catch (error) {
      console.warn("[keepalive] ping failed:", error);
    }
  };

  void ping();
  setInterval(/* Run the periodic health probe without making the timer callback wait for its result. */ () => void ping(), intervalMs);
  console.log(`[keepalive] pinging ${healthUrl} every ${Math.round(intervalMs / 1000)}s`);
}

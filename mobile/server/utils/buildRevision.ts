/**
 * Best-effort git revision for runtime identity (/api/health).
 * Render injects RENDER_GIT_COMMIT on native deploys; SOURCE_VERSION is a
 * common PaaS alias. Returns null when unset so clients can detect absence.
 */
export function resolveBuildRevision(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw =
    env.RENDER_GIT_COMMIT?.trim() ||
    env.SOURCE_VERSION?.trim() ||
    env.GIT_COMMIT?.trim() ||
    "";
  return raw.length > 0 ? raw : null;
}

/** True when live revision equals or uniquely prefixes the expected SHA. */
export function revisionMatchesExpected(
  live: string | null | undefined,
  expectedSha: string,
): boolean {
  if (!live || !expectedSha) return false;
  const a = live.trim().toLowerCase();
  const b = expectedSha.trim().toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

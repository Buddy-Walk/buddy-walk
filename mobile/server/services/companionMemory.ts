const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const PING_EXTENSION_MS = 60 * 60 * 1000;

export interface MemoryCompanionSession {
  token: string;
  ownerSecret: string;
  displayName?: string;
  active: boolean;
  lastLat?: number;
  lastLon?: number;
  lastAccuracy?: number;
  lastHeading?: number;
  lastSpeed?: number;
  lastUpdate?: Date;
  createdAt: Date;
  expiresAt: Date;
  pingCount: number;
}

const sessions = new Map<string, MemoryCompanionSession>();

/** Remove expired fallback sessions before reads or creation so stale viewer tokens stop resolving. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt.getTime() <= now) sessions.delete(token);
  }
}

export const companionMemoryStore = {
  /** Check token uniqueness after pruning expired in-memory sessions. */
  exists(token: string): boolean {
    pruneExpired();
    return sessions.has(token);
  },

  /** Create a fallback session with an initial ping count after expiring stale records. */
  create(data: Omit<MemoryCompanionSession, 'pingCount'> & { pingCount?: number }) {
    pruneExpired();
    const doc: MemoryCompanionSession = { pingCount: 0, ...data };
    sessions.set(doc.token, doc);
    return doc;
  },

  /** Return a live fallback session or null, deleting an expired record when encountered. */
  findOne(token: string): MemoryCompanionSession | null {
    pruneExpired();
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expiresAt.getTime() <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return s;
  },

  /** Persist the updated fallback session under its existing token. */
  save(session: MemoryCompanionSession): MemoryCompanionSession {
    sessions.set(session.token, session);
    return session;
  },

  sessionTtlMs: SESSION_TTL_MS,
  pingExtensionMs: PING_EXTENSION_MS,
};

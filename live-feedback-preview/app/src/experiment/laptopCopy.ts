import { strToU8 } from 'fflate';

import type { SessionFolder, SessionsRoot } from './sessionStore';

/** The part of `fetch` the copy uses. */
type Send = (url: string, init: { method: string; body?: Uint8Array<ArrayBuffer> }) => Promise<Response>;

export type CopiedSessionsRoot = SessionsRoot & {
  /** Resolves once everything written so far has been sent, or has failed to send. */
  sent(): Promise<void>;
};

/**
 * The phone's sessions, with every file written to them also sent to the laptop, through
 * the Metro dev server the app was loaded from (`devServer/experimentSessions.js`).
 *
 * The phone's files stay the real ones: sending never holds up or fails a write.
 * A file the laptop missed, for example while it was out of reach, is sent whole the next
 * time anything is sent.
 * Removing a session on the phone keeps the laptop's copy.
 */
export function withLaptopCopy(phone: SessionsRoot, devServerUrl: string, send: Send = fetch): CopiedSessionsRoot {
  // Requests go one at a time, in the order the files were written.
  let queue = Promise.resolve();
  /** Files the laptop's copy may not match, by `session/file`. */
  const missed = new Map<string, { session: string; file: string }>();
  /** How many bytes each appended file has on the phone, by `session/file`. */
  const appendedSizes = new Map<string, number>();

  function request(method: string, session: string, file: string, body?: Uint8Array, query = '') {
    const url = `${devServerUrl}/experiment-sessions/${encodeURIComponent(session)}/${encodeURIComponent(file)}${query}`;
    // fetch's types refuse bytes that could be shared memory, and file bytes never are.
    return send(url, { method, body: body as Uint8Array<ArrayBuffer> | undefined });
  }

  /** Makes the laptop's file match the phone's. */
  async function resend(session: string, file: string) {
    // A removed session keeps the laptop's copy as it is. Opening its folder would also recreate it on the phone.
    if (!phone.folderNames().includes(session)) {
      missed.delete(`${session}/${file}`);
      return;
    }
    const folder = phone.folder(session);
    const response = folder.fileNames().includes(file)
      ? await request('PUT', session, file, folder.readBytes(file))
      : await request('DELETE', session, file);
    if (!response.ok) throw new Error(`The laptop refused ${session}/${file}: ${response.status}`);
    missed.delete(`${session}/${file}`);
  }

  function enqueue(session: string, file: string, change: () => Promise<Response>) {
    queue = queue.then(async () => {
      try {
        for (const earlier of [...missed.values()]) await resend(earlier.session, earlier.file);
        const response = await change();
        // An append the laptop can't place, because its copy is missing an earlier part.
        if (!response.ok) await resend(session, file);
      } catch {
        missed.set(`${session}/${file}`, { session, file });
      }
    });
  }

  function folder(session: string): SessionFolder {
    const inner = phone.folder(session);
    return {
      ...inner,
      appendText(file, text) {
        const key = `${session}/${file}`;
        const offset = appendedSizes.get(key) ?? byteLength(inner.readText(file) ?? '');
        inner.appendText(file, text);
        const bytes = strToU8(text);
        appendedSizes.set(key, offset + bytes.length);
        enqueue(session, file, () => request('POST', session, file, bytes, `?offset=${offset}`));
      },
      writeBytes(file, bytes) {
        inner.writeBytes(file, bytes);
        appendedSizes.delete(`${session}/${file}`);
        enqueue(session, file, () => request('PUT', session, file, bytes));
      },
      deleteFile(file) {
        inner.deleteFile(file);
        appendedSizes.delete(`${session}/${file}`);
        enqueue(session, file, () => request('DELETE', session, file));
      },
    };
  }

  return {
    folderNames: () => phone.folderNames(),
    folder,
    remove(session) {
      phone.remove(session);
      // A later session can reuse the name, so its sizes start again.
      for (const key of appendedSizes.keys()) if (key.startsWith(`${session}/`)) appendedSizes.delete(key);
    },
    sent: () => queue,
  };
}

function byteLength(text: string) {
  return strToU8(text).length;
}

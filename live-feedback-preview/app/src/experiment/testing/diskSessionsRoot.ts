import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionFolder, SessionsRoot } from '../sessionStore';

/** A `SessionsRoot` on the laptop's disk, in a fresh temporary directory, for tests. */
export function diskSessionsRoot(): SessionsRoot {
  const path = mkdtempSync(join(tmpdir(), 'experiment-sessions-'));

  function folder(name: string): SessionFolder {
    const dir = join(path, name);
    mkdirSync(dir, { recursive: true });
    return {
      appendText: (file, text) => appendFileSync(join(dir, file), text),
      readText: (file) => {
        try {
          return readFileSync(join(dir, file), 'utf8');
        } catch {
          return null;
        }
      },
      writeBytes: (file, bytes) => writeFileSync(join(dir, file), bytes),
      readBytes: (file) => new Uint8Array(readFileSync(join(dir, file))),
      deleteFile: (file) => rmSync(join(dir, file)),
      fileNames: () => readdirSync(dir),
    };
  }

  return {
    folderNames: () => readdirSync(path),
    folder,
    remove: (name) => rmSync(join(path, name), { recursive: true }),
  };
}

import { Directory, File, Paths } from 'expo-file-system';

import type { SessionFolder, SessionsRoot } from './sessionStore';

/** Experiment sessions on the phone, in the app's documents folder. */
export function fileSystemSessionsRoot(): SessionsRoot {
  const root = new Directory(Paths.document, 'experiment-sessions');
  root.create({ idempotent: true, intermediates: true });

  function folder(name: string): SessionFolder {
    const dir = new Directory(root, name);
    dir.create({ idempotent: true });
    return {
      appendText: (file, text) => new File(dir, file).writeSync(text, { append: true }),
      readText: (file) => {
        const handle = new File(dir, file);
        return handle.exists ? handle.textSync() : null;
      },
      writeBytes: (file, bytes) => new File(dir, file).writeSync(bytes),
      readBytes: (file) => new File(dir, file).bytesSync(),
      deleteFile: (file) => new File(dir, file).delete(),
      fileNames: () => dir.list().map((entry) => entry.name),
    };
  }

  return {
    folderNames: () =>
      root
        .list()
        .filter((entry) => entry instanceof Directory)
        .map((entry) => entry.name),
    folder,
    remove: (name) => new Directory(root, name).delete(),
  };
}

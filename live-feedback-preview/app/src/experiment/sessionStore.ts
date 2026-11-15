import { strToU8, zipSync, type Zippable } from 'fflate';

import type { FrameReadings } from '../readings/Reading';
import {
  SESSION_VERSION,
  type ExperimentSession,
  type Heading,
  type LoggedReading,
  type Mark,
  type SessionInfo,
} from './session';

/** One session's folder. File names are plain names, never paths. */
export interface SessionFolder {
  appendText(file: string, text: string): void;
  /** Null when the file does not exist. */
  readText(file: string): string | null;
  writeBytes(file: string, bytes: Uint8Array): void;
  readBytes(file: string): Uint8Array;
  deleteFile(file: string): void;
  fileNames(): string[];
}

/** The folder that holds one folder per session. */
export interface SessionsRoot {
  folderNames(): string[];
  /** Opens a session's folder, creating it if needed. */
  folder(name: string): SessionFolder;
  remove(name: string): void;
}

export type Clock = { now: () => Date };

const LOG_FILE = 'log.jsonl';

/** Buffered Readings are written at least this often, so a killed app loses only the last few seconds. */
const FLUSH_INTERVAL_MS = 2000;

/**
 * Each line of a session's log is one of these.
 * The log is only ever appended to, so a session cut off partway still reloads.
 */
type LogEntry =
  | ({ kind: 'started'; version: typeof SESSION_VERSION; id: string; startedAt: string } & SessionInfo)
  | { kind: 'frame'; heading: Heading | null; readings: FrameReadings['readings'] }
  | ({ kind: 'mark' } & Mark)
  | ({ kind: 'progress'; at: string } & Counts)
  | ({ kind: 'ended'; endedAt: string } & Counts);

/** `activeMs` is how long the session has been logging, which leaves out time paused. */
type Counts = { framesProcessed: number; activeMs: number };

export type SessionRecorder = {
  id: string;
  /** Records one processed frame, with or without Readings. Frames while paused are left out. */
  addFrame(frame: FrameReadings, heading: Heading | null): void;
  /** Saves the JPEG of a Mark's frame straight away and returns its file name. */
  saveMarkFrame(jpeg: Uint8Array): string;
  /** Removes the frame of a Mark the tester cancelled. */
  discardMarkFrame(frameFile: string): void;
  /** Records a Mark, writing it straight away. */
  addMark(mark: Mark): void;
  /** Writes everything buffered so far. */
  flush(): void;
  /**
   * Stops logging, for example because the app went to the background and the camera stopped,
   * or a Mark's form is open. Also writes what is buffered.
   */
  pause(): void;
  resume(): void;
  stop(): void;
};

export function createSessionStore(root: SessionsRoot, clock: Clock = { now: () => new Date() }) {
  function start(info: SessionInfo): SessionRecorder {
    const startedAt = clock.now();
    const id = unusedSessionId(startedAt);
    const folder = root.folder(id);
    const write = (entries: LogEntry[]) => folder.appendText(LOG_FILE, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));

    write([{ kind: 'started', version: SESSION_VERSION, id, startedAt: startedAt.toISOString(), ...info }]);

    let buffered: LogEntry[] = [];
    let framesProcessed = 0;
    let lastFlush = startedAt.getTime();
    let markFrames = 0;
    let activeMs = 0;
    let activeSince: number | null = startedAt.getTime();

    function counts(at: Date): Counts {
      return { framesProcessed, activeMs: activeMs + (activeSince === null ? 0 : at.getTime() - activeSince) };
    }

    function flush() {
      const at = clock.now();
      write([...buffered, { kind: 'progress', at: at.toISOString(), ...counts(at) }]);
      buffered = [];
      lastFlush = at.getTime();
    }

    return {
      id,
      addFrame(frame, heading) {
        if (activeSince === null) return;
        framesProcessed += 1;
        if (frame.readings.length > 0) buffered.push({ kind: 'frame', heading, readings: frame.readings });
        if (clock.now().getTime() - lastFlush >= FLUSH_INTERVAL_MS) flush();
      },
      saveMarkFrame(jpeg) {
        markFrames += 1;
        const frameFile = `mark-${String(markFrames).padStart(3, '0')}.jpg`;
        folder.writeBytes(frameFile, jpeg);
        return frameFile;
      },
      discardMarkFrame(frameFile) {
        folder.deleteFile(frameFile);
      },
      addMark(mark) {
        buffered.push({ kind: 'mark', ...mark });
        flush();
      },
      flush,
      pause() {
        if (activeSince === null) return;
        const at = clock.now();
        activeMs += at.getTime() - activeSince;
        activeSince = null;
        flush();
      },
      resume() {
        if (activeSince === null) activeSince = clock.now().getTime();
      },
      stop() {
        const at = clock.now();
        write([...buffered, { kind: 'ended', endedAt: at.toISOString(), ...counts(at) }]);
        buffered = [];
      },
    };
  }

  /** The session's id, with a number added if a session already started in the same second. */
  function unusedSessionId(startedAt: Date) {
    const base = sessionId(startedAt);
    const taken = new Set(root.folderNames());
    let id = base;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
    return id;
  }

  function load(id: string): ExperimentSession {
    const text = root.folder(id).readText(LOG_FILE);
    if (text === null) throw new Error(`Session ${id} has no log`);
    return fromLog(parseLog(text));
  }

  /** Past sessions, newest first. A session that cannot be read is still listed, so it can be deleted. */
  function list(): SessionSummary[] {
    return root
      .folderNames()
      .sort()
      .reverse()
      .map((id): SessionSummary => {
        let session: ExperimentSession;
        try {
          session = load(id);
        } catch {
          return { readable: false, id };
        }
        return {
          readable: true,
          id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          readingCount: session.readings.length,
          markCount: session.marks.length,
        };
      });
  }

  function remove(id: string) {
    root.remove(id);
  }

  /**
   * A zip of the session, for the share sheet: `<id>/session.json` and the frames of its Marks.
   * Frames of Marks whose form was never saved are left out.
   */
  function exportArchive(id: string): Uint8Array {
    const session = load(id);
    const folder = root.folder(id);
    const files: Zippable = { [`${id}/session.json`]: strToU8(JSON.stringify(session, null, 2)) };
    for (const mark of session.marks) {
      // JPEGs are already compressed, so they are stored as they are.
      files[`${id}/${mark.frameFile}`] = [folder.readBytes(mark.frameFile), { level: 0 }];
    }
    return zipSync(files);
  }

  return { start, load, list, remove, exportArchive };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

export type SessionSummary =
  | ({ readable: true; readingCount: number; markCount: number } & Pick<ExperimentSession, 'id' | 'startedAt' | 'endedAt'>)
  | { readable: false; id: string };

/** Folder-safe and sortable, for example `2026-11-15T14-00-00Z`. */
function sessionId(startedAt: Date) {
  return startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

// Every complete line ends with a newline, so anything after the last one is a line
// cut off by the app being killed mid-write, and is dropped.
function parseLog(text: string): LogEntry[] {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  return complete
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogEntry);
}

function fromLog(entries: LogEntry[]): ExperimentSession {
  const [started] = entries;
  if (started?.kind !== 'started') throw new Error('Session log does not begin with its start');

  const readings: LoggedReading[] = [];
  const marks: Mark[] = [];
  let endedAt: string | null = null;
  let counts: Counts = { framesProcessed: 0, activeMs: 0 };

  for (const entry of entries) {
    switch (entry.kind) {
      case 'frame':
        for (const reading of entry.readings) readings.push({ ...reading, heading: entry.heading });
        break;
      case 'mark': {
        const { kind: _kind, ...mark } = entry;
        marks.push(mark);
        break;
      }
      case 'progress':
        counts = { framesProcessed: entry.framesProcessed, activeMs: entry.activeMs };
        break;
      case 'ended':
        endedAt = entry.endedAt;
        counts = { framesProcessed: entry.framesProcessed, activeMs: entry.activeMs };
        break;
    }
  }

  const { framesProcessed, activeMs } = counts;
  const seconds = activeMs / 1000;
  return {
    version: started.version,
    id: started.id,
    device: started.device,
    app: started.app,
    startedAt: started.startedAt,
    endedAt,
    framesProcessed,
    framesPerSecond: seconds > 0 ? Math.round((framesProcessed / seconds) * 100) / 100 : null,
    readings,
    marks,
  };
}

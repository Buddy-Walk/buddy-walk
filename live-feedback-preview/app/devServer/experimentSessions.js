// @ts-check
const { appendFile, mkdir, rm, stat, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const PREFIX = '/experiment-sessions/';

// The same rule the phone follows: file and session names are plain names, never paths.
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Keeps a copy of the experiment sessions a Debug build of the app records while it runs
 * against this Metro, one folder per session in `folder`. The app's side is
 * src/experiment/laptopCopy.ts.
 *
 * PUT    /experiment-sessions/<session>/<file>              replaces the file
 * POST   /experiment-sessions/<session>/<file>?offset=<n>   appends to the file, which must be n bytes long;
 *                                                           409 with its length when it is not
 * DELETE /experiment-sessions/<session>/<file>              deletes the file
 *
 * @param {string} folder
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void}
 */
function experimentSessionsMiddleware(folder) {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(PREFIX)) {
      next();
      return;
    }
    handle(folder, req, res, url).catch((error) => reply(res, 500, String(error)));
  };
}

/**
 * @param {string} folder
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handle(folder, req, res, url) {
  const names = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
  if (names.length !== 2 || !names.every((name) => PLAIN_NAME.test(name))) {
    reply(res, 400, 'Expected /experiment-sessions/<session>/<file> with plain names');
    return;
  }
  const [session, file] = names;
  const path = join(folder, session, file);

  switch (req.method) {
    case 'PUT': {
      const body = await readBody(req);
      await mkdir(join(folder, session), { recursive: true });
      await writeFile(path, body);
      reply(res, 204);
      return;
    }
    case 'POST': {
      const offset = Number(url.searchParams.get('offset'));
      if (!Number.isInteger(offset) || offset < 0) {
        reply(res, 400, 'Expected ?offset=<bytes already sent>');
        return;
      }
      const body = await readBody(req);
      const size = await sizeOf(path);
      if (size === offset) {
        await mkdir(join(folder, session), { recursive: true });
        await appendFile(path, body);
      } else if (size < offset + body.length) {
        // The copy is missing an earlier part, or has only part of this one, so the phone sends the whole file.
        reply(res, 409, String(size));
        return;
      }
      // Otherwise the copy already has these bytes, from a whole file sent after this append was queued.
      reply(res, 204);
      return;
    }
    case 'DELETE':
      await rm(path, { force: true });
      reply(res, 204);
      return;
    default:
      reply(res, 405);
  }
}

/** @param {string} path */
async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} [body]
 */
function reply(res, status, body) {
  res.statusCode = status;
  res.end(body);
}

module.exports = { experimentSessionsMiddleware };

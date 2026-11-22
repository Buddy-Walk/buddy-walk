import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { experimentSessionsMiddleware } from '../../devServer/experimentSessions';
import { withLaptopCopy } from './laptopCopy';
import { diskSessionsRoot } from './testing/diskSessionsRoot';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The dev server's experiment sessions endpoint, saving into a fresh temporary folder. */
async function laptop() {
  const folder = mkdtempSync(join(tmpdir(), 'laptop-sessions-'));
  const receive = experimentSessionsMiddleware(folder);
  const server = createServer((req, res) =>
    receive(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    read: (session: string, file: string) => readFileSync(join(folder, session, file)),
    fileNames: (session: string) => readdirSync(join(folder, session)).sort(),
  };
}

describe('withLaptopCopy', () => {
  test('a session written on the phone is copied to the laptop', async () => {
    const { url, read, fileNames } = await laptop();
    const phone = withLaptopCopy(diskSessionsRoot(), url);

    const folder = phone.folder('2026-11-15T14-00-00Z');
    folder.appendText('log.jsonl', '{"kind":"started"}\n');
    folder.writeBytes('mark-001.jpg', new Uint8Array([0xff, 0xd8, 0xff]));
    folder.appendText('log.jsonl', '{"kind":"ended","note":"café"}\n');
    await phone.sent();

    expect(fileNames('2026-11-15T14-00-00Z')).toEqual(['log.jsonl', 'mark-001.jpg']);
    expect(read('2026-11-15T14-00-00Z', 'log.jsonl').toString('utf8')).toBe(
      '{"kind":"started"}\n{"kind":"ended","note":"café"}\n',
    );
    expect([...read('2026-11-15T14-00-00Z', 'mark-001.jpg')]).toEqual([0xff, 0xd8, 0xff]);
  });

  test('what the laptop missed while out of reach is sent once it is back, without gaps or repeats', async () => {
    const { url, read, fileNames } = await laptop();
    let reachable = true;
    const phone = withLaptopCopy(diskSessionsRoot(), url, (input, init) =>
      reachable ? fetch(input, init) : Promise.reject(new TypeError('Network request failed')),
    );

    const folder = phone.folder('2026-11-15T14-00-00Z');
    folder.appendText('log.jsonl', 'one\n');
    await phone.sent();
    reachable = false;
    folder.appendText('log.jsonl', 'two\n');
    folder.writeBytes('mark-001.jpg', new Uint8Array([1, 2, 3]));
    folder.appendText('log.jsonl', 'three\n');
    await phone.sent();
    reachable = true;
    folder.appendText('log.jsonl', 'four\n');
    await phone.sent();

    expect(fileNames('2026-11-15T14-00-00Z')).toEqual(['log.jsonl', 'mark-001.jpg']);
    expect(read('2026-11-15T14-00-00Z', 'log.jsonl').toString('utf8')).toBe('one\ntwo\nthree\nfour\n');
    expect([...read('2026-11-15T14-00-00Z', 'mark-001.jpg')]).toEqual([1, 2, 3]);
  });

  test("a cancelled Mark's frame is deleted on the laptop too", async () => {
    const { url, fileNames } = await laptop();
    const phone = withLaptopCopy(diskSessionsRoot(), url);

    const folder = phone.folder('2026-11-15T14-00-00Z');
    folder.appendText('log.jsonl', 'one\n');
    folder.writeBytes('mark-001.jpg', new Uint8Array([1, 2, 3]));
    folder.deleteFile('mark-001.jpg');
    await phone.sent();

    expect(fileNames('2026-11-15T14-00-00Z')).toEqual(['log.jsonl']);
  });

  test("removing a session on the phone keeps the laptop's copy", async () => {
    const { url, read } = await laptop();
    let reachable = true;
    const onPhone = diskSessionsRoot();
    const phone = withLaptopCopy(onPhone, url, (input, init) =>
      reachable ? fetch(input, init) : Promise.reject(new TypeError('Network request failed')),
    );

    phone.folder('2026-11-15T14-00-00Z').appendText('log.jsonl', 'one\n');
    await phone.sent();
    reachable = false;
    phone.folder('2026-11-15T14-00-00Z').appendText('log.jsonl', 'two\n');
    // Removed while that append is still waiting to be sent.
    phone.remove('2026-11-15T14-00-00Z');
    await phone.sent();
    reachable = true;
    phone.folder('2026-11-15T14-01-00Z').appendText('log.jsonl', 'next\n');
    await phone.sent();

    expect(read('2026-11-15T14-00-00Z', 'log.jsonl').toString('utf8')).toBe('one\n');
    expect(onPhone.folderNames()).toEqual(['2026-11-15T14-01-00Z']);
  });
});

describe('experimentSessionsMiddleware', () => {
  test('refuses names that are not plain names, so nothing is written outside its folder', async () => {
    const { url } = await laptop();

    for (const path of ['%2E%2E%2Fescape/x.txt','session/%2E%2E%2Fescape.txt', 'session/sub%2Fescape.txt', 'session', 'a/b/c']) {
      const response = await fetch(`${url}/experiment-sessions/${path}`, { method: 'PUT', body: 'x' });
      expect(response.status).toBe(400);
    }
  });

  test('passes other requests on to Metro', async () => {
    const { url } = await laptop();

    const response = await fetch(`${url}/index.bundle`);

    expect(response.status).toBe(404);
  });
});

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SIDEKICK_ROOT } from './linked.ts';
import { BROWSERS, EXTENSION_ID, HOST_NAME, registerRunsHost } from './runs-host.ts';

let base: string;
let main: string;
let worktree: string;
let home: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) throw new Error(result.stderr);
}

function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);

  head.writeUInt32LE(body.length);

  return Buffer.concat([head, body]);
}

async function snapshot(dir: string) {
  const files = await readdir(dir, { recursive: true, withFileTypes: true });

  return Object.fromEntries(
    await Promise.all(
      files
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);

          return [path.relative(dir, file), await readFile(file, 'utf8')] as const;
        }),
    ),
  );
}

beforeAll(async () => {
  const built = spawnSync('pnpm', ['--filter', '@frogbotai/sidekick-mcp', 'build'], {
    cwd: SIDEKICK_ROOT,
    encoding: 'utf8',
  });

  if (built.status !== 0) throw new Error(built.stdout + built.stderr);

  base = await realpath(await mkdtemp(path.join(tmpdir(), 'sidekick-runs-host-')));
  main = path.join(base, 'sidekick');
  worktree = path.join(base, 'sidekick-ticket1');
  home = path.join(base, 'home');

  await mkdir(main);
  git(main, 'init', '-q');

  git(
    main,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );

  git(main, 'worktree', 'add', '-q', '-b', 'ticket', worktree);

  await cp(
    path.join(SIDEKICK_ROOT, 'packages/mcp/dist'),
    path.join(worktree, 'packages/mcp/dist'),
    { recursive: true },
  );
}, 60_000);

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('registerRunsHost', () => {
  it('installs the host into the main checkout from a worktree, and registers it in each Chrome', async () => {
    const registered = await registerRunsHost({
      checkout: worktree,
      home,
      platform: 'darwin',
      node: process.execPath,
    });

    const folder = path.join(main, '.idea/runs-host');
    const launcher = path.join(folder, 'sidekick-runs');

    expect(registered).toEqual({
      main,
      runs: path.join(main, '.idea/runs'),
      launcher,
      manifests: BROWSERS.map((browser) =>
        path.join(
          home,
          'Library/Application Support',
          browser,
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        ),
      ),
    });

    expect((await readdir(folder)).sort()).toEqual([
      'package.json',
      'runs-host.js',
      'runs.js',
      'sidekick-runs',
    ]);

    expect((await stat(launcher)).mode & 0o777).toBe(0o755);

    expect(await readFile(launcher, 'utf8')).toBe(
      `#!/bin/sh\nexec '${process.execPath}' '${folder}/runs-host.js' '${main}/.idea/runs'\n`,
    );

    if (!('manifests' in registered)) throw new Error('skipped');

    for (const file of registered.manifests) {
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        name: HOST_NAME,
        description: 'Saves each FrogBot Sidekick dev run to .idea/runs',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      });
    }
  });

  it('gives a launcher Chrome can start: it writes the run into the main checkout', () => {
    const launcher = path.join(main, '.idea/runs-host/sidekick-runs');
    const input = Buffer.concat([
      frame({ type: 'open', name: '2026-10-24-hi-k3v9x2ab.json', key: 'k3v9x2ab' }),
      frame({ type: 'chunk', text: '{"sidekickExport":1}\n' }),
      frame({ type: 'close' }),
    ]);

    const result = spawnSync(launcher, [`chrome-extension://${EXTENSION_ID}/`], {
      input,
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(result.status).toBe(0);

    expect(JSON.parse(result.stdout.subarray(4).toString())).toEqual({
      ok: true,
      file: '2026-10-24-hi-k3v9x2ab.json',
    });
  });

  it('gives the same files when run again', async () => {
    const before = { idea: await snapshot(path.join(main, '.idea')), home: await snapshot(home) };

    await registerRunsHost({ checkout: worktree, home, platform: 'darwin' });

    expect({ idea: await snapshot(path.join(main, '.idea')), home: await snapshot(home) }).toEqual(
      before,
    );

    expect(before.idea['runs/2026-10-24-hi-k3v9x2ab.json']).toBe('{"sidekickExport":1}\n');
  });

  it('skips other platforms and writes nothing', async () => {
    const elsewhere = path.join(base, 'elsewhere');

    expect(
      await registerRunsHost({ checkout: worktree, home: elsewhere, platform: 'linux' }),
    ).toEqual({ skipped: 'run saving is macOS only (linux)' });

    await expect(stat(elsewhere)).rejects.toThrow();
  });
});

import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIDEKICK_ROOT } from './linked.ts';

/** The native-messaging host's name; `@frogbotai/sidekick-mcp`'s `RUNS_HOST`. */
export const HOST_NAME = 'ai.frogbot.sidekick_runs';

/** The Web Store ID, which the dev build shares through the manifest key. */
export const EXTENSION_ID = 'kilnglameccalibejghopglodbidhkmj';

/** The host's files, copied out of `packages/mcp/dist`. */
export const HOST_FILES = ['runs.js', 'runs-host.js'];

/** The Chromes whose user-level `NativeMessagingHosts/` gets the host, under `Application Support`. */
export const BROWSERS = ['Google/Chrome', 'Google/Chrome for Testing', 'Chromium'];

export interface RegisterOptions {
  /** The checkout `pnpm dev` runs in: the main one or a `sidekick-ticket<n>` worktree. */
  checkout: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The Node the launcher runs, as an absolute path: Chrome starts hosts with a minimal `PATH`. */
  node?: string;
}

export type Registered =
  { skipped: string } | { main: string; runs: string; launcher: string; manifests: string[] };

/** The main checkout of `checkout`'s repository, so a worktree's runs outlive the worktree. */
export function mainCheckout(checkout: string) {
  const result = spawnSync(
    'git',
    ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  );

  return result.status === 0 ? path.dirname(result.stdout.trim()) : checkout;
}

function launcher(node: string, host: string, runs: string) {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

  return `#!/bin/sh\nexec ${quote(node)} ${quote(host)} ${quote(runs)}\n`;
}

/**
 * Registers the dev build's run writer with Chrome on macOS: copies the host into
 * `<main>/.idea/runs-host/`, writes a launcher that saves into `<main>/.idea/runs/`, and points
 * each Chrome's host manifest at it. Running it again gives the same files.
 */
export async function registerRunsHost({
  checkout,
  home = homedir(),
  platform = process.platform,
  node = process.execPath,
}: RegisterOptions): Promise<Registered> {
  if (platform !== 'darwin') return { skipped: `run saving is macOS only (${platform})` };

  const main = mainCheckout(checkout);
  const folder = path.join(main, '.idea', 'runs-host');
  const runs = path.join(main, '.idea', 'runs');
  const dist = path.join(checkout, 'packages', 'mcp', 'dist');
  const script = path.join(folder, 'sidekick-runs');

  await mkdir(folder, { recursive: true });
  await mkdir(runs, { recursive: true });

  for (const file of HOST_FILES) await copyFile(path.join(dist, file), path.join(folder, file));

  await writeFile(path.join(folder, 'package.json'), '{ "type": "module" }\n');
  await writeFile(script, launcher(node, path.join(folder, 'runs-host.js'), runs));
  await chmod(script, 0o755);

  const manifest = `${JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Saves each FrogBot Sidekick dev run to .idea/runs',
      path: script,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`;

  const manifests = BROWSERS.map((browser) =>
    path.join(
      home,
      'Library',
      'Application Support',
      browser,
      'NativeMessagingHosts',
      `${HOST_NAME}.json`,
    ),
  );

  for (const file of manifests) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, manifest);
  }

  return { main, runs, launcher: script, manifests };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const registered = await registerRunsHost({ checkout: SIDEKICK_ROOT });

    console.log(
      'skipped' in registered
        ? `Sidekick runs: not saved, ${registered.skipped}`
        : `Sidekick runs: saved to ${registered.runs}`,
    );
  } catch (error) {
    console.warn(`Sidekick runs: not saved, registering the writer failed: ${String(error)}`);
  }
}

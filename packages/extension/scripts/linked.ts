import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { WxtViteConfig } from 'wxt';

/** The WXT mode the `:local` commands pass. Only this mode turns the redirect on. */
export const LINKED_MODE = 'linked';

/** Carries the FrogBot checkout from the `:local` commands to `wxt.config.ts`. */
export const CHECKOUT_ENV = 'SIDEKICK_FROGBOT';

/** The Sidekick checkout this file belongs to. */
export const SIDEKICK_ROOT = path.resolve(import.meta.dirname, '../../..');

const TICKET_KEY = /^\d+[a-z]?$/;

const SCOPE = '@frogbotai/';

type VitePlugin = Extract<NonNullable<WxtViteConfig['plugins']>[number], { name: string }>;

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** A FrogBot package Sidekick depends on, served from the checkout in linked mode. */
export interface LinkedPackage {
  name: string;
  /** The package's folder in the FrogBot checkout. */
  dir: string;
  /** The `package.json` of the published copy Sidekick has installed. Peers resolve from it. */
  installed: string;
  peers: string[];
  /** The Sidekick package folders that depend on it. */
  consumers: string[];
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function packageDirs(root: string) {
  const packages = path.join(root, 'packages');

  if (!existsSync(packages)) return [];

  return readdirSync(packages, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(packages, entry.name, 'package.json')),
    )
    .map((entry) => path.join(packages, entry.name));
}

function packageName(id: string) {
  const parts = id.split('/');

  return id.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? id);
}

/**
 * Finds the FrogBot checkout for `arg`: a ticket key (`272`, `210b`) means the
 * `frogbot-ticket<key>` folder next to Sidekick, a path is used as given, and
 * nothing means the `frogbot` folder next to Sidekick.
 */
export function resolveCheckout(
  arg: string | undefined,
  sidekickRoot: string,
  cwd = process.cwd(),
) {
  const parent = path.dirname(sidekickRoot);

  let checkout = path.join(parent, 'frogbot');

  if (arg && TICKET_KEY.test(arg)) checkout = path.join(parent, `frogbot-ticket${arg}`);
  else if (arg) checkout = path.resolve(cwd, arg);

  if (!existsSync(path.join(checkout, 'package.json'))) {
    throw new Error(`No FrogBot checkout at ${checkout}`);
  }

  return checkout;
}

/**
 * Lists the `@frogbotai/*` packages Sidekick depends on that exist in the
 * checkout. Throws when the checkout or Sidekick is missing an installed dependency.
 */
export function linkedPackages(checkout: string, sidekickRoot: string): LinkedPackage[] {
  const local = new Map(packageDirs(checkout).map((dir) => [readManifest(dir).name, dir]));
  const linked = new Map<string, LinkedPackage>();

  for (const consumer of packageDirs(sidekickRoot)) {
    const manifest = readManifest(consumer);
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    for (const name of names) {
      const dir = local.get(name);

      if (!name.startsWith(SCOPE) || !dir) continue;

      const existing = linked.get(name);

      if (existing) {
        existing.consumers.push(consumer);
        continue;
      }

      const installed = path.join(consumer, 'node_modules', name, 'package.json');

      if (!existsSync(installed)) {
        throw new Error(`${sidekickRoot}: ${name} is not installed; run \`pnpm install\` there`);
      }

      const own = readManifest(dir);
      const missing = Object.keys(own.dependencies ?? {}).find(
        (dep) => !existsSync(path.join(dir, 'node_modules', dep)),
      );

      if (missing) {
        throw new Error(
          `${checkout}: dependencies are not installed (${name} needs ${missing}); run \`pnpm install\` there`,
        );
      }

      linked.set(name, {
        name,
        dir,
        installed: realpathSync(installed),
        peers: Object.keys(own.peerDependencies ?? {}),
        consumers: [consumer],
      });
    }
  }

  return [...linked.values()];
}

/**
 * Picks the importer a linked-mode import resolves from: the checkout package
 * for a linked id, and Sidekick's installed copy for a peer imported from the
 * checkout. Returns `undefined` when the import resolves as usual.
 */
export function linkedImporter(
  source: string,
  importer: string | undefined,
  packages: LinkedPackage[],
  checkout: string,
) {
  const name = packageName(source);
  const linked = packages.find((pkg) => pkg.name === name);

  if (linked) return path.join(linked.dir, 'package.json');

  if (!importer?.startsWith(checkout + path.sep)) return undefined;

  return packages.find((pkg) => pkg.peers.includes(name))?.installed;
}

/**
 * The files WXT's auto-import transform skips in linked mode: its defaults plus
 * the checkout, whose source it would otherwise rewrite as if it were Sidekick's.
 */
export function unimportExclude(checkout: string) {
  const real = realpathSync(checkout).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/, new RegExp(`^${real}[\\\\/]`)];
}

function cacheDir(checkout: string, sidekickRoot: string) {
  const lockfile = path.join(checkout, 'pnpm-lock.yaml');
  const hash = createHash('sha256').update(checkout);

  if (existsSync(lockfile)) hash.update(readFileSync(lockfile));

  return path.join(
    sidekickRoot,
    'packages/extension/node_modules/.vite',
    `linked-${hash.digest('hex').slice(0, 8)}`,
  );
}

/** The Vite config that serves Sidekick's `@frogbotai/*` imports from the checkout. */
export function linkedVite(checkout: string, sidekickRoot: string): WxtViteConfig {
  const packages = linkedPackages(checkout, sidekickRoot);
  const real = realpathSync(checkout);

  const target = (source: string, importer: string | undefined) =>
    linkedImporter(source, importer, packages, real);

  const plugin: VitePlugin = {
    name: 'sidekick:linked',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const from = target(source, importer);

      if (!from) return null;

      const resolved = await this.resolve(source, from, { ...options, skipSelf: true });

      if (!resolved && packages.some((pkg) => pkg.name === packageName(source))) {
        throw new Error(`${source} is not exported by ${path.dirname(from)}`);
      }

      return resolved;
    },
  };

  return {
    cacheDir: cacheDir(real, sidekickRoot),
    plugins: [plugin],
    optimizeDeps: {
      rolldownOptions: {
        plugins: [
          {
            name: 'sidekick:linked-peers',
            async resolveId(source, importer, options) {
              const from = target(source, importer);

              return from ? this.resolve(source, from, { ...options, skipSelf: true }) : null;
            },
          },
        ],
      },
    },
  };
}

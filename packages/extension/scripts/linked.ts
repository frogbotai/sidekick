import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

import { searchForWorkspaceRoot } from 'vite';
import type { WxtViteConfig } from 'wxt';

/** Overrides the FrogBot checkout Sidekick builds against: a path, or a ticket key (`290`). */
export const CHECKOUT_ENV = 'SIDEKICK_FROGBOT';

/** The symlink at Sidekick's root that points at the FrogBot checkout; `link:` dependencies go through it. */
export const LINK = '.frogbot';

/** The Sidekick checkout this file belongs to. */
export const SIDEKICK_ROOT = path.resolve(import.meta.dirname, '../../..');

const TICKET_KEY = /^\d+[a-z]?$/;

const SCOPE = '@frogbotai/';

const LINK_SPEC = 'link:';

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** A FrogBot package Sidekick takes by `link:` from the checkout. */
export interface LinkedPackage {
  name: string;
  /** The package's folder in the FrogBot checkout. */
  dir: string;
  peers: string[];
  /** The Sidekick package folders that depend on it. */
  consumers: string[];
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** The folders under `packages/` that hold a `package.json`. */
export function packageDirs(root: string) {
  const packages = path.join(root, 'packages');

  if (!existsSync(packages)) return [];

  return readdirSync(packages, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(packages, entry.name, 'package.json')),
    )
    .map((entry) => path.join(packages, entry.name));
}

function missingCheckout(checkout: string) {
  return new Error(
    `No FrogBot checkout at ${checkout}. Sidekick builds against a local FrogBot checkout: clone FrogBot there, or set ${CHECKOUT_ENV} to its path (or a ticket key, like 290).`,
  );
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

  if (!existsSync(path.join(checkout, 'package.json'))) throw missingCheckout(checkout);

  return checkout;
}

function linkSpecs(sidekickRoot: string) {
  return packageDirs(sidekickRoot).flatMap((consumer) => {
    const manifest = readManifest(consumer);
    const specs = { ...manifest.dependencies, ...manifest.devDependencies };

    return Object.entries(specs)
      .filter(([name, spec]) => name.startsWith(SCOPE) && spec.startsWith(LINK_SPEC))
      .map(([name, spec]) => ({ consumer, name, target: spec.slice(LINK_SPEC.length) }));
  });
}

/** Whether Sidekick takes any `@frogbotai/*` package from the FrogBot checkout, not npm. */
export function isLinked(sidekickRoot: string) {
  return linkSpecs(sidekickRoot).length > 0;
}

/**
 * Points `<sidekickRoot>/.frogbot` at the checkout `value` names (see
 * `resolveCheckout`) and returns it. Returns `null` when every `@frogbotai/*`
 * dependency comes from npm.
 */
export function linkCheckout(
  sidekickRoot: string,
  value = process.env[CHECKOUT_ENV],
  cwd = process.env.INIT_CWD,
) {
  if (!isLinked(sidekickRoot)) return null;

  const checkout = resolveCheckout(value, sidekickRoot, cwd);
  const link = path.join(sidekickRoot, LINK);
  const target = path.relative(sidekickRoot, checkout);
  const stat = lstatSync(link, { throwIfNoEntry: false });

  if (stat && !stat.isSymbolicLink()) throw new Error(`${link} is not a symlink; remove it`);

  if (stat && path.resolve(sidekickRoot, readlinkSync(link)) === checkout) return checkout;

  if (stat) unlinkSync(link);

  symlinkSync(target, link, 'dir');

  return checkout;
}

/** The checkout `.frogbot` points at, failing with what to do when it points nowhere. */
export function linkedCheckout(sidekickRoot: string) {
  const link = path.join(sidekickRoot, LINK);
  const stat = lstatSync(link, { throwIfNoEntry: false });

  if (!stat) {
    throw new Error(`${link} is missing; run \`pnpm install\` to link the FrogBot checkout`);
  }

  const checkout = path.resolve(sidekickRoot, readlinkSync(link));

  if (!existsSync(path.join(checkout, 'package.json'))) throw missingCheckout(checkout);

  return realpathSync(checkout);
}

/**
 * Lists the `@frogbotai/*` packages Sidekick takes by `link:`. Throws when the
 * link points nowhere or the checkout is missing an installed dependency.
 */
export function linkedPackages(sidekickRoot: string): LinkedPackage[] {
  const specs = linkSpecs(sidekickRoot);
  const linked = new Map<string, LinkedPackage>();

  if (specs.length === 0) return [];

  const checkout = linkedCheckout(sidekickRoot);

  for (const { consumer, name, target } of specs) {
    const existing = linked.get(name);

    if (existing) {
      existing.consumers.push(consumer);
      continue;
    }

    const linkedDir = path.resolve(consumer, target);

    if (!existsSync(path.join(linkedDir, 'package.json'))) {
      throw new Error(`${checkout} has no ${name} (Sidekick links ${target})`);
    }

    const dir = realpathSync(linkedDir);
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
      peers: Object.keys(own.peerDependencies ?? {}),
      consumers: [consumer],
    });
  }

  return [...linked.values()];
}

/** The peers of the linked packages that Sidekick has installed, so one copy of each runs. */
export function sharedPeers(packages: LinkedPackage[]) {
  const peers = packages.flatMap((pkg) =>
    pkg.peers.filter((peer) =>
      pkg.consumers.some((consumer) =>
        existsSync(path.join(consumer, 'node_modules', peer, 'package.json')),
      ),
    ),
  );

  return [...new Set(peers)].sort();
}

/**
 * The files WXT's auto-import transform skips: its defaults plus the checkout,
 * whose source it would otherwise rewrite as if it were Sidekick's.
 */
export function unimportExclude(sidekickRoot: string) {
  const defaults = [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/];

  if (!isLinked(sidekickRoot)) return defaults;

  const real = linkedCheckout(sidekickRoot).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return [...defaults, new RegExp(`^${real}[\\\\/]`)];
}

function cacheDir(checkout: string, sidekickRoot: string) {
  const lockfile = path.join(checkout, 'pnpm-lock.yaml');
  const hash = createHash('sha256').update(checkout);

  if (existsSync(lockfile)) hash.update(readFileSync(lockfile));

  return path.join(
    sidekickRoot,
    'packages/extension/node_modules/.vite',
    `frogbot-${hash.digest('hex').slice(0, 8)}`,
  );
}

/**
 * The Vite config for linked packages: their source is served from the
 * checkout, while each shared peer (`react`, `ai`, …) resolves to Sidekick's copy.
 */
export function linkedVite(sidekickRoot: string, root: string): WxtViteConfig {
  const packages = linkedPackages(sidekickRoot);

  if (packages.length === 0) return {};

  const checkout = linkedCheckout(sidekickRoot);

  return {
    cacheDir: cacheDir(checkout, sidekickRoot),
    resolve: { dedupe: sharedPeers(packages) },
    server: { fs: { allow: [searchForWorkspaceRoot(root), checkout] } },
  };
}

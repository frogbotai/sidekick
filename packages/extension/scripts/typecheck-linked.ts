import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import type { LinkedPackage } from './linked.ts';

type Paths = Record<string, string[]>;

type ExportEntry = string | { types?: string };

interface PublishManifest {
  name: string;
  dependencies?: Record<string, string>;
  publishConfig?: { types?: string; exports?: Record<string, ExportEntry> };
}

interface TsconfigJson {
  extends?: string;
  compilerOptions?: { baseUrl?: string; paths?: Paths };
}

function readTsconfig(file: string): TsconfigJson {
  return ts.readConfigFile(file, ts.sys.readFile).config ?? {};
}

/** The `paths` a tsconfig inherits, made absolute so another config can merge them. */
export function inheritedPaths(file: string): Paths {
  const config = readTsconfig(file);
  const dir = path.dirname(file);
  const paths = config.compilerOptions?.paths;

  if (paths) {
    const base = path.resolve(dir, config.compilerOptions?.baseUrl ?? '.');

    return Object.fromEntries(
      Object.entries(paths).map(([key, values]) => [
        key,
        values.map((value) => path.resolve(base, value)),
      ]),
    );
  }

  if (!config.extends) return {};

  const parent = path.resolve(dir, config.extends);

  return inheritedPaths(parent.endsWith('.json') ? parent : `${parent}.json`);
}

/**
 * Points a checkout package, and every FrogBot workspace package it depends
 * on, at the declarations its `publishConfig` ships.
 */
export function declarationPaths(dir: string, paths: Paths = {}): Paths {
  const manifest: PublishManifest = JSON.parse(
    readFileSync(path.join(dir, 'package.json'), 'utf8'),
  );

  const exports = manifest.publishConfig?.exports;

  if (paths[manifest.name]) return paths;

  if (manifest.publishConfig?.types) {
    paths[manifest.name] = [path.join(dir, manifest.publishConfig.types)];
  }

  for (const [key, entry] of Object.entries(exports ?? {})) {
    if (typeof entry === 'string' || !entry.types) continue;

    paths[manifest.name + key.slice(1)] = [path.join(dir, entry.types)];
  }

  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range.startsWith('workspace:')) {
      declarationPaths(realpathSync(path.join(dir, 'node_modules', dep)), paths);
    }
  }

  return paths;
}

function typesName(peer: string) {
  return peer.startsWith('@') ? `@types/${peer.slice(1).replace('/', '__')}` : `@types/${peer}`;
}

/** Points each peer of a linked package at the copy Sidekick has installed. */
export function peerPaths(pkg: LinkedPackage, consumer: string): Paths {
  const installedDir = path.dirname(pkg.installed);
  const store = installedDir.slice(0, -pkg.name.length - 1);
  const paths: Paths = {};

  for (const peer of pkg.peers) {
    const dir = [
      path.join(consumer, 'node_modules', typesName(peer)),
      path.join(consumer, 'node_modules', peer),
      path.join(store, typesName(peer)),
      path.join(store, peer),
    ].find((candidate) => existsSync(path.join(candidate, 'package.json')));

    if (!dir) continue;

    paths[peer] = [dir];
    paths[`${peer}/*`] = [`${dir}/*`];
  }

  return paths;
}

/**
 * Writes a non-composite tsconfig into each Sidekick package that depends on
 * a linked package, under its `node_modules/.cache` so `types` still resolve
 * from the package. Linked packages resolve to the checkout's built
 * declarations. Returns the written files.
 */
export function writeLinkedTsconfigs(packages: LinkedPackage[]) {
  const consumers = [...new Set(packages.flatMap((pkg) => pkg.consumers))];

  return consumers.map((consumer) => {
    const tsconfig = path.join(consumer, 'tsconfig.json');
    const linked = packages.filter((pkg) => pkg.consumers.includes(consumer));
    const paths: Paths = { ...inheritedPaths(tsconfig) };

    for (const pkg of linked) {
      Object.assign(paths, peerPaths(pkg, consumer), declarationPaths(pkg.dir));
    }

    const file = path.join(consumer, 'node_modules/.cache/typecheck-linked/tsconfig.json');
    const config = {
      extends: tsconfig,
      compilerOptions: {
        composite: false,
        incremental: false,
        tsBuildInfoFile: null,
        noEmit: true,
        paths,
      },
    };

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

    return file;
  });
}

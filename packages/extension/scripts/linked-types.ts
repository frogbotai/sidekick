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
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Paths };
}

/** Where a Sidekick package's `tsconfig.json` `extends` the generated paths, relative to the package. */
export const TYPES_CONFIG = 'node_modules/.cache/frogbot/tsconfig.json';

function readTsconfig(file: string): TsconfigJson {
  return ts.readConfigFile(file, ts.sys.readFile).config ?? {};
}

function extendsOf(file: string, config: TsconfigJson) {
  const dir = path.dirname(file);
  const parents = typeof config.extends === 'string' ? [config.extends] : (config.extends ?? []);

  return parents
    .map((parent) => path.resolve(dir, parent))
    .map((parent) => (parent.endsWith('.json') ? parent : `${parent}.json`));
}

/**
 * The `paths` a tsconfig inherits, made absolute so another config can merge
 * them. `skip` is left out of its `extends`.
 */
export function inheritedPaths(file: string, skip?: string): Paths {
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

  const parents = extendsOf(file, config).filter((parent) => parent !== skip);

  return Object.assign({}, ...parents.map((parent) => inheritedPaths(parent)));
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

/** Points each peer of a linked package at the copy the consumer has installed. */
export function peerPaths(pkg: LinkedPackage, consumer: string): Paths {
  const paths: Paths = {};

  for (const peer of pkg.peers) {
    const dir = [typesName(peer), peer]
      .map((name) => path.join(consumer, 'node_modules', name))
      .find((candidate) => existsSync(path.join(candidate, 'package.json')));

    if (!dir) continue;

    paths[peer] = [dir];
    paths[`${peer}/*`] = [`${dir}/*`];
  }

  return paths;
}

/**
 * Writes `TYPES_CONFIG` into each Sidekick package whose `tsconfig.json`
 * extends it: the `paths` that point its linked packages at the checkout's
 * built declarations (the ones npm users get) and their peers at the package's
 * own copies. With nothing linked it adds no paths. Returns the written files.
 */
export function writeTypesConfigs(packageDirs: string[], packages: LinkedPackage[]) {
  return packageDirs.flatMap((consumer) => {
    const tsconfig = path.join(consumer, 'tsconfig.json');
    const file = path.join(consumer, TYPES_CONFIG);

    if (!existsSync(tsconfig) || !extendsOf(tsconfig, readTsconfig(tsconfig)).includes(file)) {
      return [];
    }

    const linked = packages.filter((pkg) => pkg.consumers.includes(consumer));
    const paths: Paths = {};

    for (const pkg of linked) {
      Object.assign(paths, peerPaths(pkg, consumer), declarationPaths(pkg.dir));
    }

    const config =
      linked.length > 0
        ? { compilerOptions: { paths: { ...inheritedPaths(tsconfig, file), ...paths } } }
        : {};

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

    return [file];
  });
}

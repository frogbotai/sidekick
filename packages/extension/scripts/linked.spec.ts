import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createViteServer } from 'vitest/node';
import type { ConfigEnv } from 'wxt';

import config from '../wxt.config.ts';
import {
  CHECKOUT_ENV,
  LINKED_MODE,
  linkedPackages,
  linkedVite,
  resolveCheckout,
  unimportExclude,
} from './linked.ts';
import { declarationPaths, inheritedPaths, peerPaths } from './typecheck-linked.ts';

let base: string;
let sidekick: string;
let checkout: string;

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

async function touch(file: string, contents = '') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function fakePackage(dir: string, name: string, files: string[]) {
  await writeJson(path.join(dir, 'package.json'), { name, main: './index.js' });

  for (const file of files) await touch(path.join(dir, file), 'export {};');
}

async function link(target: string, at: string) {
  await mkdir(path.dirname(at), { recursive: true });
  await symlink(target, at, 'dir');
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'sidekick-linked-')));
  sidekick = path.join(base, 'sidekick');
  checkout = path.join(base, 'frogbot');

  const ui = path.join(checkout, 'packages/ui');

  await writeJson(path.join(checkout, 'package.json'), { name: 'frogbot-monorepo' });
  await touch(path.join(checkout, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

  await writeJson(path.join(ui, 'package.json'), {
    name: '@frogbotai/ui',
    type: 'module',
    exports: {
      '.': { types: './src/index.ts', import: './src/index.ts', default: './src/index.ts' },
      './chat/rest': {
        import: './src/exports/chat-rest.ts',
        default: './src/exports/chat-rest.ts',
      },
      './styles.css': './src/styles.css',
    },
    peerDependencies: { ai: '^7.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    dependencies: { '@frogbotai/protocol': 'workspace:*' },
    publishConfig: {
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './chat/rest': { types: './dist/exports/chat-rest.d.ts' },
        './styles.css': './src/styles.css',
      },
    },
  });

  await touch(path.join(ui, 'src/index.ts'), 'export {};');
  await touch(path.join(ui, 'src/exports/chat-rest.ts'), 'export {};');
  await touch(path.join(ui, 'src/styles.css'), ':root {}');
  await fakePackage(path.join(ui, 'node_modules/react'), 'react', ['index.js', 'jsx-runtime.js']);

  await link(
    path.join(checkout, 'packages/protocol'),
    path.join(ui, 'node_modules/@frogbotai/protocol'),
  );

  await writeJson(path.join(checkout, 'packages/protocol/package.json'), {
    name: '@frogbotai/protocol',
    publishConfig: { exports: { '.': { types: './dist/index.d.ts' } } },
  });

  await writeJson(path.join(checkout, 'packages/sdk/package.json'), {
    name: '@frogbotai/sdk',
    peerDependencies: { zod: '^4.0.0' },
  });

  const store = path.join(sidekick, 'node_modules/.pnpm/@frogbotai+ui@0.32.0/node_modules');

  await fakePackage(path.join(store, '@frogbotai/ui'), '@frogbotai/ui', ['index.js']);
  await fakePackage(path.join(store, 'react'), 'react', ['index.js', 'jsx-runtime.js']);
  await fakePackage(path.join(store, 'ai'), 'ai', ['index.js']);

  await fakePackage(
    path.join(sidekick, 'node_modules/.pnpm/sdk/@frogbotai/sdk'),
    '@frogbotai/sdk',
    [],
  );

  await writeJson(path.join(sidekick, 'packages/extension/package.json'), {
    name: '@frogbotai/sidekick-extension',
    dependencies: {
      '@frogbotai/sidekick-core': 'workspace:^',
      '@frogbotai/ui': '0.32.0',
      react: '19.2.6',
    },
  });

  await link(
    path.join(store, '@frogbotai/ui'),
    path.join(sidekick, 'packages/extension/node_modules/@frogbotai/ui'),
  );

  await writeJson(path.join(sidekick, 'packages/core/package.json'), {
    name: '@frogbotai/sidekick-core',
    devDependencies: { '@frogbotai/sdk': '0.32.0' },
  });

  await link(
    path.join(sidekick, 'node_modules/.pnpm/sdk/@frogbotai/sdk'),
    path.join(sidekick, 'packages/core/node_modules/@frogbotai/sdk'),
  );

  await writeJson(path.join(base, 'frogbot-ticket210b/package.json'), { name: 'frogbot-monorepo' });
  await writeJson(path.join(base, 'elsewhere/package.json'), { name: 'frogbot-monorepo' });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveCheckout', () => {
  it('picks the sibling frogbot folder, a ticket worktree or a path', () => {
    expect(resolveCheckout(undefined, sidekick)).toBe(checkout);
    expect(resolveCheckout('', sidekick)).toBe(checkout);
    expect(resolveCheckout('210b', sidekick)).toBe(path.join(base, 'frogbot-ticket210b'));
    expect(resolveCheckout('../elsewhere', sidekick, sidekick)).toBe(path.join(base, 'elsewhere'));
    expect(resolveCheckout(checkout, sidekick)).toBe(checkout);
  });

  it('names the path it tried when there is no checkout', () => {
    expect(() => resolveCheckout('272', sidekick)).toThrow(
      `No FrogBot checkout at ${path.join(base, 'frogbot-ticket272')}`,
    );

    expect(() => resolveCheckout('missing', sidekick, base)).toThrow(
      `No FrogBot checkout at ${path.join(base, 'missing')}`,
    );
  });
});

describe('linkedPackages', () => {
  it('lists the FrogBot packages Sidekick depends on, with their peers', () => {
    const packages = linkedPackages(checkout, sidekick);

    expect(packages.map((pkg) => pkg.name).sort()).toEqual(['@frogbotai/sdk', '@frogbotai/ui']);

    expect(new Set(packages.flatMap((pkg) => pkg.peers))).toEqual(
      new Set(['ai', 'react', 'react-dom', 'zod']),
    );
  });

  it('says to run pnpm install in a checkout with a missing dependency', async () => {
    const ui = path.join(checkout, 'packages/ui/package.json');
    const manifest = {
      name: '@frogbotai/ui',
      dependencies: { '@frogbotai/missing': 'workspace:*' },
    };

    const original = await readFile(ui, 'utf8');

    await writeJson(ui, manifest);

    try {
      expect(() => linkedPackages(checkout, sidekick)).toThrow(
        `${checkout}: dependencies are not installed (@frogbotai/ui needs @frogbotai/missing); run \`pnpm install\` there`,
      );
    } finally {
      await writeFile(ui, original);
    }
  });
});

describe('linkedVite', () => {
  it('serves the checkout source and Sidekick’s own peers', async () => {
    const extension = path.join(sidekick, 'packages/extension');
    const linked = linkedVite(checkout, sidekick);
    const server = await createViteServer({
      root: extension,
      configFile: false,
      logLevel: 'silent',
      plugins: linked.plugins,
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true },
    });

    const resolve = async (id: string, importer = path.join(extension, 'src/main.ts')) =>
      (await server.environments.client.pluginContainer.resolveId(id, importer))?.id;

    const store = path.join(sidekick, 'node_modules/.pnpm/@frogbotai+ui@0.32.0/node_modules');
    const fromCheckout = path.join(checkout, 'packages/ui/src/index.ts');

    try {
      expect(await resolve('@frogbotai/ui')).toBe(fromCheckout);

      expect(await resolve('@frogbotai/ui/chat/rest')).toBe(
        path.join(checkout, 'packages/ui/src/exports/chat-rest.ts'),
      );

      expect(await resolve('@frogbotai/ui/styles.css')).toBe(
        path.join(checkout, 'packages/ui/src/styles.css'),
      );

      expect(await resolve('react', fromCheckout)).toBe(path.join(store, 'react/index.js'));

      expect(await resolve('react/jsx-runtime', fromCheckout)).toBe(
        path.join(store, 'react/jsx-runtime.js'),
      );

      expect(await resolve('ai', fromCheckout)).toBe(path.join(store, 'ai/index.js'));
    } finally {
      await server.close();
    }

    expect(linked.cacheDir).toMatch(
      /packages\/extension\/node_modules\/\.vite\/linked-[0-9a-f]{8}$/,
    );
  });

  it('keeps WXT’s auto-imports out of the checkout', () => {
    const exclude = unimportExclude(checkout);

    expect(
      exclude.some((pattern) => pattern.test(path.join(checkout, 'packages/ui/src/index.ts'))),
    ).toBe(true);

    expect(
      exclude.some((pattern) => pattern.test(path.join(sidekick, 'packages/extension/src/a.ts'))),
    ).toBe(false);
  });
});

describe('typecheck:local configs', () => {
  it('points linked packages and their workspace deps at the published declarations', () => {
    const ui = path.join(checkout, 'packages/ui');

    expect(declarationPaths(ui)).toEqual({
      '@frogbotai/ui': [path.join(ui, 'dist/index.d.ts')],
      '@frogbotai/ui/chat/rest': [path.join(ui, 'dist/exports/chat-rest.d.ts')],
      '@frogbotai/protocol': [path.join(checkout, 'packages/protocol/dist/index.d.ts')],
    });
  });

  it('points peers at the copy Sidekick has installed', () => {
    const ui = linkedPackages(checkout, sidekick).find((pkg) => pkg.name === '@frogbotai/ui');
    const store = path.join(sidekick, 'node_modules/.pnpm/@frogbotai+ui@0.32.0/node_modules');

    expect(ui && peerPaths(ui, path.join(sidekick, 'packages/extension'))).toEqual({
      ai: [path.join(store, 'ai')],
      'ai/*': [path.join(store, 'ai/*')],
      react: [path.join(store, 'react')],
      'react/*': [path.join(store, 'react/*')],
    });
  });

  it('keeps the inherited paths, made absolute', async () => {
    const extension = path.join(sidekick, 'packages/extension');

    await writeJson(path.join(extension, 'tsconfig.json'), { extends: './.wxt/tsconfig.json' });

    await writeJson(path.join(extension, '.wxt/tsconfig.json'), {
      compilerOptions: { paths: { '@/*': ['../src/*'] } },
    });

    expect(inheritedPaths(path.join(extension, 'tsconfig.json'))).toEqual({
      '@/*': [path.join(extension, 'src/*')],
    });
  });
});

describe('wxt.config.ts', () => {
  const env = (mode: string): ConfigEnv => ({
    mode,
    command: 'build',
    browser: 'chrome',
    manifestVersion: 3,
  });

  it('adds no redirect without the linked mode, even with the variable set', async () => {
    vi.stubEnv(CHECKOUT_ENV, checkout);

    try {
      const vite = await config.vite?.(env('production'));

      expect(vite?.plugins).toBeUndefined();
      expect(vite?.cacheDir).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails in linked mode when the checkout is missing', async () => {
    vi.stubEnv(CHECKOUT_ENV, path.join(base, 'missing'));

    try {
      await expect(async () => config.vite?.(env(LINKED_MODE))).rejects.toThrow(
        `No FrogBot checkout at ${path.join(base, 'missing')}`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

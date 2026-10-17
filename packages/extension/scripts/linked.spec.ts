import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createViteServer } from 'vitest/node';
import type { ConfigEnv } from 'wxt';

import config from '../wxt.config.ts';
import {
  CHECKOUT_ENV,
  isLinked,
  LINK,
  linkCheckout,
  linkedPackages,
  linkedVite,
  resolveCheckout,
  unimportExclude,
} from './linked.ts';
import {
  declarationPaths,
  inheritedPaths,
  peerPaths,
  TYPES_CONFIG,
  writeTypesConfigs,
} from './linked-types.ts';

let base: string;
let sidekick: string;
let extension: string;
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

async function fakeSidekick(root: string, ui: string) {
  await writeJson(path.join(root, 'packages/extension/package.json'), {
    name: '@frogbotai/sidekick-extension',
    dependencies: {
      '@frogbotai/sidekick-core': 'workspace:^',
      '@frogbotai/ui': ui,
      react: '19.2.6',
    },
  });

  await writeJson(path.join(root, 'packages/core/package.json'), {
    name: '@frogbotai/sidekick-core',
  });
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'sidekick-linked-')));
  sidekick = path.join(base, 'sidekick');
  extension = path.join(sidekick, 'packages/extension');
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
    peerDependencies: { ai: '^7.0.0', payload: '3.90.2', react: '^19.0.0' },
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

  await fakeSidekick(sidekick, 'link:../../.frogbot/packages/ui');

  await link(
    '../../../../.frogbot/packages/ui',
    path.join(extension, 'node_modules/@frogbotai/ui'),
  );

  await fakePackage(path.join(extension, 'node_modules/react'), 'react', [
    'index.js',
    'jsx-runtime.js',
  ]);

  await fakePackage(path.join(extension, 'node_modules/ai'), 'ai', ['index.js']);
  await fakePackage(path.join(extension, 'node_modules/@types/react'), '@types/react', []);

  await writeJson(path.join(base, 'frogbot-ticket210b/package.json'), { name: 'frogbot-monorepo' });
  await writeJson(path.join(base, 'elsewhere/package.json'), { name: 'frogbot-monorepo' });

  linkCheckout(sidekick, undefined, sidekick);
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

  it('names the path it tried and the variable to set when there is no checkout', () => {
    expect(() => resolveCheckout('272', sidekick)).toThrow(
      `No FrogBot checkout at ${path.join(base, 'frogbot-ticket272')}. Sidekick builds against a local FrogBot checkout: clone FrogBot there, or set ${CHECKOUT_ENV} to its path`,
    );

    expect(() => resolveCheckout('missing', sidekick, base)).toThrow(
      `No FrogBot checkout at ${path.join(base, 'missing')}`,
    );
  });
});

describe('linkCheckout', () => {
  const at = () => path.join(sidekick, LINK);

  it('points .frogbot at the sibling checkout by default, with a relative link', async () => {
    expect(linkCheckout(sidekick, undefined, sidekick)).toBe(checkout);
    expect(await readlink(at())).toBe('../frogbot');
  });

  it('follows the variable, and goes back without it', async () => {
    try {
      expect(linkCheckout(sidekick, '210b', sidekick)).toBe(path.join(base, 'frogbot-ticket210b'));
      expect(await readlink(at())).toBe('../frogbot-ticket210b');
    } finally {
      linkCheckout(sidekick, undefined, sidekick);
    }

    expect(await readlink(at())).toBe('../frogbot');
  });

  it('leaves the link alone when the checkout is missing', async () => {
    expect(() => linkCheckout(sidekick, 'missing', base)).toThrow(
      `No FrogBot checkout at ${path.join(base, 'missing')}`,
    );

    expect(await readlink(at())).toBe('../frogbot');
  });

  it('does nothing when every FrogBot package comes from npm', async () => {
    const npm = path.join(base, 'npm-sidekick');

    await fakeSidekick(npm, '0.33.0');

    expect(isLinked(npm)).toBe(false);
    expect(linkCheckout(npm, 'missing', base)).toBeNull();
    expect(await lstat(path.join(npm, LINK)).catch(() => null)).toBeNull();
    expect(linkedPackages(npm)).toEqual([]);
    expect(linkedVite(npm, path.join(npm, 'packages/extension'))).toEqual({});
  });
});

describe('linkedPackages', () => {
  it('lists the packages Sidekick links, read from the checkout', () => {
    expect(linkedPackages(sidekick)).toEqual([
      {
        name: '@frogbotai/ui',
        dir: path.join(checkout, 'packages/ui'),
        peers: ['ai', 'payload', 'react'],
        consumers: [extension],
      },
    ]);
  });

  it('says where the checkout should be when the link points nowhere', async () => {
    const dangling = path.join(base, 'dangling-sidekick');

    await fakeSidekick(dangling, 'link:../../.frogbot/packages/ui');
    await link('../gone', path.join(dangling, LINK));

    expect(() => linkedPackages(dangling)).toThrow(
      `No FrogBot checkout at ${path.join(base, 'gone')}`,
    );

    await rm(path.join(dangling, LINK));

    expect(() => linkedPackages(dangling)).toThrow(
      `${path.join(dangling, LINK)} is missing; run \`pnpm install\``,
    );
  });

  it('says to run pnpm install in a checkout with a missing dependency', async () => {
    const ui = path.join(checkout, 'packages/ui/package.json');
    const original = await readFile(ui, 'utf8');

    await writeJson(ui, {
      name: '@frogbotai/ui',
      dependencies: { '@frogbotai/missing': 'workspace:*' },
    });

    try {
      expect(() => linkedPackages(sidekick)).toThrow(
        `${checkout}: dependencies are not installed (@frogbotai/ui needs @frogbotai/missing); run \`pnpm install\` there`,
      );
    } finally {
      await writeFile(ui, original);
    }
  });
});

describe('linkedVite', () => {
  it('serves the checkout source through the link, with Sidekick’s own peers', async () => {
    const linked = linkedVite(sidekick, extension);
    const server = await createViteServer({
      ...linked,
      root: extension,
      configFile: false,
      logLevel: 'silent',
      server: { ...linked.server, middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true },
    });

    const resolve = async (id: string, importer = path.join(extension, 'src/main.ts')) =>
      (await server.environments.client.pluginContainer.resolveId(id, importer))?.id;

    const fromCheckout = path.join(checkout, 'packages/ui/src/index.ts');

    try {
      expect(await resolve('@frogbotai/ui')).toBe(fromCheckout);

      expect(await resolve('@frogbotai/ui/chat/rest')).toBe(
        path.join(checkout, 'packages/ui/src/exports/chat-rest.ts'),
      );

      expect(await resolve('@frogbotai/ui/styles.css')).toBe(
        path.join(checkout, 'packages/ui/src/styles.css'),
      );

      expect(await resolve('react', fromCheckout)).toBe(
        path.join(extension, 'node_modules/react/index.js'),
      );

      expect(await resolve('react/jsx-runtime', fromCheckout)).toBe(
        path.join(extension, 'node_modules/react/jsx-runtime.js'),
      );

      expect(await resolve('ai', fromCheckout)).toBe(
        path.join(extension, 'node_modules/ai/index.js'),
      );
    } finally {
      await server.close();
    }

    expect(linked.resolve?.dedupe).toEqual(['ai', 'react']);
    expect(linked.server?.fs?.allow).toContain(checkout);

    expect(linked.cacheDir).toMatch(
      /packages\/extension\/node_modules\/\.vite\/frogbot-[0-9a-f]{8}$/,
    );
  });

  it('keeps WXT’s auto-imports out of the checkout', () => {
    const exclude = unimportExclude(sidekick);

    expect(
      exclude.some((pattern) => pattern.test(path.join(checkout, 'packages/ui/src/index.ts'))),
    ).toBe(true);

    expect(exclude.some((pattern) => pattern.test(path.join(extension, 'src/a.ts')))).toBe(false);
  });
});

describe('types configs', () => {
  it('points linked packages and their workspace deps at the published declarations', () => {
    const ui = path.join(checkout, 'packages/ui');

    expect(declarationPaths(ui)).toEqual({
      '@frogbotai/ui': [path.join(ui, 'dist/index.d.ts')],
      '@frogbotai/ui/chat/rest': [path.join(ui, 'dist/exports/chat-rest.d.ts')],
      '@frogbotai/protocol': [path.join(checkout, 'packages/protocol/dist/index.d.ts')],
    });
  });

  it('points peers at the consumer’s own copy, preferring its @types package', () => {
    const [ui] = linkedPackages(sidekick);

    expect(ui && peerPaths(ui, extension)).toEqual({
      ai: [path.join(extension, 'node_modules/ai')],
      'ai/*': [path.join(extension, 'node_modules/ai/*')],
      react: [path.join(extension, 'node_modules/@types/react')],
      'react/*': [path.join(extension, 'node_modules/@types/react/*')],
    });
  });

  it('writes the paths into packages that extend the config, keeping their other paths', async () => {
    const generated = path.join(extension, TYPES_CONFIG);

    await writeJson(path.join(extension, 'tsconfig.json'), {
      extends: ['./.wxt/tsconfig.json', `./${TYPES_CONFIG}`],
    });

    await writeJson(path.join(extension, '.wxt/tsconfig.json'), {
      compilerOptions: { paths: { '@/*': ['../src/*'] } },
    });

    expect(inheritedPaths(path.join(extension, 'tsconfig.json'), generated)).toEqual({
      '@/*': [path.join(extension, 'src/*')],
    });

    expect(writeTypesConfigs([extension], linkedPackages(sidekick))).toEqual([generated]);

    const { compilerOptions } = JSON.parse(await readFile(generated, 'utf8'));

    expect(compilerOptions.paths['@/*']).toEqual([path.join(extension, 'src/*')]);

    expect(compilerOptions.paths['@frogbotai/ui']).toEqual([
      path.join(checkout, 'packages/ui/dist/index.d.ts'),
    ]);

    expect(writeTypesConfigs([extension], [])).toEqual([generated]);
    expect(JSON.parse(await readFile(generated, 'utf8'))).toEqual({});

    expect(writeTypesConfigs([path.join(sidekick, 'packages/core')], [])).toEqual([]);
  });
});

describe('wxt.config.ts', () => {
  const env: ConfigEnv = {
    mode: 'production',
    command: 'build',
    browser: 'chrome',
    manifestVersion: 3,
  };

  it('dedupes the linked packages’ peers and keeps its own aliases', async () => {
    const vite = await config.vite?.(env);

    expect(vite?.resolve?.dedupe).toEqual(expect.arrayContaining(['ai', 'react', 'react-dom']));
    expect(vite?.resolve?.alias).toHaveProperty('@ai-sdk/gateway');
  });
});

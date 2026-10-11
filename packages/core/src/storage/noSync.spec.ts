import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = decodeURIComponent(new URL('../../../../', import.meta.url).pathname);

const eslint = new ESLint({ cwd: root });

async function syncErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });

  return (result?.messages ?? []).filter(({ message }) => message.includes('PLAN D7'));
}

describe('the storage.sync lint rule', () => {
  it.each([
    ['packages/core/src/storage/example.ts', 'void chrome.storage.sync.get();\n'],
    ['packages/extension/src/example.spec.ts', 'void browser.storage.sync.get();\n'],
    ['scripts/example.mjs', "void chrome.storage['sync'].get();\n"],
    ['packages/core/src/example.ts', 'const { sync } = chrome.storage;\n\nvoid sync;\n'],
  ])('refuses storage.sync in %s', async (filePath, code) => {
    expect(await syncErrors(code, filePath)).toHaveLength(1);
  });

  it('allows storage.local', async () => {
    const code = 'void chrome.storage.local.get();\n';

    expect(await syncErrors(code, 'packages/core/src/example.ts')).toEqual([]);
  });
});

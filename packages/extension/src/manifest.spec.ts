import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'wxt';

const ROOT = path.resolve(import.meta.dirname, '..');

const STORE_ID = 'kilnglameccalibejghopglodbidhkmj';

let outBase: string;
let outDir: string;
let manifest: Record<string, unknown>;

function extensionId(key: string) {
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex');

  return [...hash.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('');
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

beforeAll(async () => {
  vi.stubEnv('SIDEKICK_E2E', '');
  outBase = await mkdtemp(path.join(tmpdir(), 'sidekick-manifest-'));
  await build({ root: ROOT, outDir: outBase });
  outDir = path.join(outBase, 'chrome-mv3');
  manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(outBase, { recursive: true, force: true });
});

describe('built manifest', () => {
  it('has exactly the expected top-level fields', () => {
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'action',
        'background',
        'content_scripts',
        'description',
        'externally_connectable',
        'host_permissions',
        'icons',
        'key',
        'manifest_version',
        'minimum_chrome_version',
        'name',
        'options_ui',
        'permissions',
        'side_panel',
        'version',
      ].sort(),
    );
  });

  it('keeps the Web Store identity', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('FrogBot Sidekick');
    expect(manifest.version).toBe('0.9.0');
    expect(typeof manifest.key).toBe('string');
    expect(extensionId(String(manifest.key))).toBe(STORE_ID);

    expect(manifest.icons).toEqual({
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    });
  });

  it('targets Chrome 123 or later, for light-dark()', () => {
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(123);
  });

  it('asks for exactly the MVP permissions', () => {
    expect(manifest.permissions).toEqual([
      'sidePanel',
      'storage',
      'tabs',
      'tabGroups',
      'scripting',
      'debugger',
      'webNavigation',
    ]);

    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.permissions).not.toContain('cookies');
  });

  it('lets only FrogBot’s connect page message the extension', () => {
    expect(manifest.externally_connectable).toEqual({ matches: ['https://app.frogbot.ai/*'] });
  });

  it('declares one passive content script in every frame', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['<all_urls>'],
        js: ['frame.js'],
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
        run_at: 'document_start',
        world: 'ISOLATED',
      },
    ]);
  });

  it('opens the side panel from the action', () => {
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(manifest.action).toEqual({ default_title: 'Open FrogBot Sidekick' });
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
  });

  it('opens the options page in Chrome’s extension menu', () => {
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: false });
  });

  it.each(['web_accessible_resources', 'content_security_policy'])('has no %s', (field) => {
    expect(manifest).not.toHaveProperty(field);
  });

  it('has no offscreen permission', () => {
    expect(manifest.permissions).not.toContain('offscreen');
  });
});

describe('built files', () => {
  it('ships the content script as one small classic script', async () => {
    const source = await readFile(path.join(outDir, 'frame.js'), 'utf8');

    expect(source).not.toMatch(/(^|[;\s}])import[\s{*("']/);
    expect(source).not.toMatch(/(^|[;\s}])export[\s{*]/);
    expect(source.length).toBeLessThan(64_000);
  });

  it('leaves the e2e and live-test pages out of production', async () => {
    const files = await listFiles(outDir);

    expect(files.filter((file) => /e2e-open|live/.test(file))).toEqual([]);
    expect(files).toContain('sidepanel.html');
  });

  it('leaves the test tool hook out of production', async () => {
    const source = await readFile(path.join(outDir, 'background.js'), 'utf8');

    expect(source).not.toContain('sidekickTest');
  });
});

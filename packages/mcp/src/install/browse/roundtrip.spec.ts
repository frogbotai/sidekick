import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BACKUP_SUFFIX, type ConfigEntry, editConfig } from './edit.js';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function folder() {
  const at = fs.mkdtempSync(path.join(tmpdir(), 'sidekick-roundtrip-'));

  folders.push(at);

  return at;
}

function file(name: string, text?: string) {
  const at = path.join(folder(), name);

  if (text !== undefined) fs.writeFileSync(at, text);

  return at;
}

const value = { command: 'npx', args: ['-y', '@frogbotai/sidekick-mcp'] };

const entry = (at: string, format: 'json' | 'toml' = 'json'): ConfigEntry => ({
  file: at,
  format,
  path: [format === 'json' ? 'mcpServers' : 'mcp_servers', 'sidekick'],
  value,
});

const read = (at: string) => fs.readFileSync(at, 'utf8');

function roundTrip(format: 'json' | 'toml', before: string) {
  const at = file(format === 'json' ? 'config.json' : 'config.toml', before);

  expect(editConfig(entry(at, format)).result).toBe('added');
  expect(editConfig(entry(at, format), true).result).toBe('removed');

  return JSON.stringify(read(at));
}

const shapes: [string, 'json' | 'toml', string][] = [
  [
    'a line comment on the last property',
    'json',
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark" // my theme\n}\n',
  ],
  [
    'a one-line servers object',
    'json',
    '{\n  "mcpServers": { "other": { "url": "https://other" } }\n}\n',
  ],
  ['minified JSON', 'json', '{"numStartups":4,"theme":"dark"}'],
  ['an empty JSON file', 'json', ''],
  ['TOML with no final newline', 'toml', '# mine\nmodel = "o3"'],
  ['TOML with trailing blank lines', 'toml', '# mine\nmodel = "o3"\n\n\n'],
];

describe('uninstall restores the bytes install found', () => {
  it.each(shapes)('keeps %s', (_name, format, before) => {
    expect(roundTrip(format, before)).toBe(JSON.stringify(before));
  });
});

describe('uninstall after the file changed since install', () => {
  it('cuts the entry and keeps the line comment where it was', () => {
    const at = file('config.json', '{\n  "theme": "dark" // my theme\n}\n');

    editConfig(entry(at));
    fs.writeFileSync(at, read(at).replace('{\n', '{\n  "added": true,\n'));

    expect(editConfig(entry(at), true).result).toBe('removed');
    expect(read(at)).toBe('{\n  "added": true,\n  "theme": "dark" // my theme\n}\n');
  });

  it('keeps trailing blank lines before an appended TOML table', () => {
    const at = file('config.toml', 'model = "o3"\n\n\n');

    editConfig(entry(at, 'toml'));
    fs.writeFileSync(at, `# top\n${read(at)}`);

    expect(editConfig(entry(at, 'toml'), true).result).toBe('removed');
    expect(read(at)).toBe('# top\nmodel = "o3"\n\n\n');
  });
});

describe('the backup', () => {
  it('is refreshed by a later install, so a container the user added since is kept', () => {
    const at = file('mcp.json', '{\n  "theme": 1\n}\n');

    editConfig(entry(at));
    editConfig(entry(at), true);

    const now = '{\n  "theme": 1,\n  "mcpServers": {}\n}\n';

    fs.writeFileSync(at, now);

    const install = editConfig(entry(at));

    expect(install.backup).toBe(`${at}${BACKUP_SUFFIX}`);
    expect(read(`${at}${BACKUP_SUFFIX}`)).toBe(now);

    fs.writeFileSync(at, read(at).replace('{\n', '{\n  "added": true,\n'));
    editConfig(entry(at), true);

    expect(read(at)).toBe(now.replace('{\n', '{\n  "added": true,\n'));
  });
});

describe('a symlinked config', () => {
  it('whose target is missing stays a link, and the target is created', () => {
    const dotfiles = folder();
    const target = path.join(dotfiles, 'nested', 'config.toml');
    const link = file('config.toml');

    fs.symlinkSync(target, link);

    expect(editConfig(entry(link, 'toml')).result).toBe('added');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(target)).toContain('[mcp_servers.sidekick]');
    expect(editConfig(entry(link, 'toml'), true).result).toBe('removed');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

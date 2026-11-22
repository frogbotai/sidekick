import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { BACKUP_SUFFIX, type ConfigEntry, editConfig, readEntry } from './edit.js';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function file(name: string, text?: string) {
  const folder = fs.mkdtempSync(path.join(tmpdir(), 'sidekick-edit-'));

  folders.push(folder);

  const at = path.join(folder, name);

  if (text !== undefined) fs.writeFileSync(at, text);

  return at;
}

const value = { command: 'npx', args: ['-y', '@frogbotai/sidekick-mcp'] };

const json = (at: string): ConfigEntry => ({
  file: at,
  format: 'json',
  path: ['mcpServers', 'sidekick'],
  value,
});

const toml = (at: string): ConfigEntry => ({
  file: at,
  format: 'toml',
  path: ['mcp_servers', 'sidekick'],
  value,
});

const read = (at: string) => fs.readFileSync(at, 'utf8');

function roundTrip(entry: ConfigEntry, before: string) {
  expect(editConfig(entry).result).toBe('added');

  const after = read(entry.file);

  expect(editConfig(entry, true).result).toBe('removed');
  expect(read(entry.file)).toBe(before);

  return after;
}

describe('json keeps comments and other servers', () => {
  it('adds beside an inline server, indented like the file, and removes back to the bytes', () => {
    const before =
      '{\n  // keep this\n  "mcpServers": {\n    "other": { "command": "x" }\n  },\n  "unrelated": true\n}\n';

    const after = roundTrip(json(file('mcp.json', before)), before);

    expect(after).toContain('// keep this');

    expect(after).toContain(
      '    "other": { "command": "x" },\n    "sidekick": {\n      "command": "npx",',
    );

    expect(parse(after).mcpServers.sidekick).toEqual(value);
  });

  it('keeps tabs and a trailing comma', () => {
    const tabs = '{\n\t"mcpServers": {\n\t\t"o": 1\n\t}\n}\n';

    expect(roundTrip(json(file('tabs.json', tabs)), tabs)).toContain(
      '\t\t"sidekick": {\n\t\t\t"command"',
    );

    const trailing = '{\n  "mcpServers": {\n    "o": 1, // mine\n  },\n}\n';
    const after = roundTrip(json(file('trailing.jsonc', trailing)), trailing);

    expect(after).toContain('"o": 1, // mine\n    "sidekick"');
    expect(parse(after, [], { allowTrailingComma: true }).mcpServers.sidekick).toEqual(value);
  });

  it('creates the container, and a missing file with mode 0600', () => {
    const empty = json(file('empty.json', '{\n  "a": 1\n}\n'));

    expect(editConfig(empty).result).toBe('added');
    expect(parse(read(empty.file))).toEqual({ a: 1, mcpServers: { sidekick: value } });
    expect(editConfig(empty, true).result).toBe('removed');
    expect(read(empty.file)).toBe('{\n  "a": 1\n}\n');

    const missing = json(file('missing.json'));

    expect(editConfig(missing).result).toBe('added');
    expect(JSON.parse(read(missing.file))).toEqual({ mcpServers: { sidekick: value } });
    expect(fs.statSync(missing.file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(missing.file + BACKUP_SUFFIX)).toBe(false);
  });
});

describe('toml keeps comments', () => {
  it('appends a block and removes it back to the bytes', () => {
    const before = '# my config\nmodel = "o3"\n\n[mcp_servers.other]\nurl = "https://other"\n';
    const after = roundTrip(toml(file('config.toml', before)), before);

    expect(after.startsWith(before)).toBe(true);
    expect(parseToml(after)).toMatchObject({ mcp_servers: { sidekick: value, other: {} } });
  });

  it('handles an empty file and one without a final newline', () => {
    const empty = toml(file('empty.toml', ''));

    expect(roundTrip(empty, '')).toBe(
      '[mcp_servers.sidekick]\ncommand = "npx"\nargs = ["-y","@frogbotai/sidekick-mcp"]\n',
    );

    const bare = toml(file('bare.toml', 'model = "o3"'));

    expect(editConfig(bare).result).toBe('added');
    expect(parseToml(read(bare.file))).toEqual({ model: 'o3', mcp_servers: { sidekick: value } });
  });

  it('removes its table written with other spacing, and refuses an inline table', () => {
    const entry = toml(file('config.toml', '# mine\n'));

    editConfig(entry);

    fs.writeFileSync(
      entry.file,
      read(entry.file).replace(
        'args = ["-y","@frogbotai/sidekick-mcp"]',
        'args = [ "-y", "@frogbotai/sidekick-mcp" ]',
      ),
    );

    expect(readEntry(entry)).toBe('owned');
    expect(editConfig(entry, true).result).toBe('removed');
    expect(read(entry.file)).toBe('# mine\n');

    const spaced =
      'model = "o3"\n\n[mcp_servers.sidekick]\ncommand = "npx"\nargs = [ "-y", "@frogbotai/sidekick-mcp" ]\n\n# my other server\n[mcp_servers.other]\ncommand = "x"\n';

    const neighbour = toml(file('neighbour.toml', spaced));

    expect(editConfig(neighbour, true).result).toBe('removed');

    expect(read(neighbour.file)).toBe(
      'model = "o3"\n\n# my other server\n[mcp_servers.other]\ncommand = "x"\n',
    );

    const inline = toml(file('inline.toml', 'mcp_servers = { other = { command = "x" } }\n'));

    expect(editConfig(inline).result).toBe('refused');
    expect(read(inline.file)).toBe('mcp_servers = { other = { command = "x" } }\n');
  });
});

describe('owned entries', () => {
  it('never changes or removes an entry it didn’t write', () => {
    const entry = json(file('mcp.json', '{}'));

    editConfig(entry);

    const edited = read(entry.file).replace('"npx"', '"/usr/local/bin/npx"');

    fs.writeFileSync(entry.file, edited);

    expect(readEntry(entry)).toBe('other');
    expect(editConfig(entry).result).toBe('conflict');
    expect(editConfig(entry, true).result).toBe('conflict');
    expect(read(entry.file)).toBe(edited);
  });

  it('leaves a file it can’t parse untouched, with no backup', () => {
    for (const entry of [
      json(file('bad.json', '{ "mcpServers": ')),
      toml(file('bad.toml', '[[x')),
    ]) {
      const before = read(entry.file);

      expect(readEntry(entry)).toBe('invalid');
      expect(editConfig(entry).result).toBe('invalid');
      expect(read(entry.file)).toBe(before);
      expect(fs.existsSync(entry.file + BACKUP_SUFFIX)).toBe(false);
    }

    const wrongShape = json(file('shape.json', '{ "mcpServers": [] }'));

    expect(editConfig(wrongShape).result).toBe('invalid');
  });
});

describe('writes', () => {
  it('restores the bytes when install created the container, and keeps one that was there', () => {
    const before = '{\n  // mine\n  "theme": "dark"\n}\n';

    expect(roundTrip(json(file('mcp.json', before)), before)).toContain('"mcpServers"');

    const empty = '{\n  "mcpServers": {}\n}\n';

    expect(roundTrip(json(file('empty.json', empty)), empty)).toContain('"sidekick"');
  });

  it('writes through a symlink to the linked file', () => {
    const target = file('dotfiles.json', '{}\n');
    const link = path.join(path.dirname(target), 'mcp.json');

    fs.symlinkSync(target, link);

    expect(editConfig(json(link)).result).toBe('added');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(parse(read(target)).mcpServers.sidekick).toEqual(value);
    expect(editConfig(json(link), true).result).toBe('removed');
    expect(read(target)).toBe('{}\n');
  });

  it('treats an empty json file as an empty config', () => {
    const entry = json(file('mcp.json', ''));

    expect(editConfig(entry).result).toBe('added');
    expect(JSON.parse(read(entry.file))).toEqual({ mcpServers: { sidekick: value } });
  });

  it('backs up before an install, keeps that backup on uninstall, and keeps the mode', () => {
    const before = '{ "mcpServers": {} }\n';
    const entry = json(file('mcp.json', before));

    fs.chmodSync(entry.file, 0o640);

    const added = editConfig(entry);

    expect(added).toEqual({ result: 'added', backup: entry.file + BACKUP_SUFFIX });
    expect(read(entry.file + BACKUP_SUFFIX)).toBe(before);
    expect(fs.statSync(entry.file + BACKUP_SUFFIX).mode & 0o777).toBe(0o640);
    expect(fs.statSync(entry.file).mode & 0o777).toBe(0o640);
    expect(editConfig(entry, true)).toEqual({ result: 'removed' });
    expect(read(entry.file + BACKUP_SUFFIX)).toBe(before);

    expect(fs.readdirSync(path.dirname(entry.file)).sort()).toEqual([
      'mcp.json',
      `mcp.json${BACKUP_SUFFIX}`,
    ]);
  });
});

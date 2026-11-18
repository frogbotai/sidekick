// Ported from anomalyco/browse, cli/src/setup/agent-config.ts. MIT License, Copyright (c) 2025 opencode.
// The full notice and the changes are in VENDORED.md beside this file.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  type ParseError,
  parseTree,
} from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';

/** The file formats an agent config comes in. */
export type ConfigFormat = 'json' | 'toml';

/** One MCP server entry in one agent's user config. */
export interface ConfigEntry {
  file: string;
  format: ConfigFormat;
  /** The keys down to the entry, for example `['mcpServers', 'sidekick']`. */
  path: readonly string[];
  value: Readonly<Record<string, unknown>>;
}

/** What is at the entry's place in the file now. */
export type EntryState = 'absent' | 'owned' | 'other' | 'invalid';

/** What an install or uninstall did to one file. */
export interface EditResult {
  result: 'added' | 'removed' | 'unchanged' | 'conflict' | 'invalid' | 'refused';
  /** The backup made before this write, when this write made one. */
  backup?: string;
}

/** The suffix of the copy made before the first write to a config file. */
export const BACKUP_SUFFIX = '.sidekick-backup';

type Parsed = { ok: true; config: Record<string, unknown> } | { ok: false };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function parseConfig(text: string, format: ConfigFormat): Parsed {
  try {
    const errors: ParseError[] = [];
    const config: unknown =
      format === 'toml' ? parseToml(text) : parse(text, errors, { allowTrailingComma: true });

    return errors.length === 0 && isObject(config) ? { ok: true, config } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function lookup(config: Record<string, unknown>, keys: readonly string[]) {
  let current: unknown = config;

  for (const key of keys) {
    if (current === undefined) return { container: true, value: undefined };

    if (!isObject(current)) return { container: false, value: undefined };

    current = Object.hasOwn(current, key) ? current[key] : undefined;
  }

  return { container: current === undefined || isObject(current), value: current };
}

function inspect(entry: ConfigEntry, text: string): EntryState {
  const parsed = parseConfig(text, entry.format);

  if (!parsed.ok) return 'invalid';

  const parent = lookup(parsed.config, entry.path.slice(0, -1));

  if (!parent.container) return 'invalid';

  const current = lookup(parsed.config, entry.path).value;

  if (current === undefined) return 'absent';

  return isDeepStrictEqual(plain(current), plain(entry.value)) ? 'owned' : 'other';
}

/** Reads what is at the entry's place without writing anything. */
export function readEntry(entry: ConfigEntry): EntryState {
  if (!fs.existsSync(entry.file)) return 'absent';

  try {
    return inspect(entry, fs.readFileSync(entry.file, 'utf8'));
  } catch {
    return 'invalid';
  }
}

/** The value at the entry's place, or undefined when it's absent or the file doesn't parse. */
export function readValue(entry: ConfigEntry): unknown {
  try {
    const parsed = parseConfig(fs.readFileSync(entry.file, 'utf8'), entry.format);

    return parsed.ok ? plain(lookup(parsed.config, entry.path).value) : undefined;
  } catch {
    return undefined;
  }
}

function indentUnit(text: string) {
  const match = /^([ \t]+)\S/m.exec(text);

  if (!match?.[1]) return '  ';

  return match[1].startsWith('\t') ? '\t' : match[1];
}

function insertJson(before: string, keys: readonly string[], value: unknown) {
  const tree = parseTree(before);
  let depth = 0;

  while (depth < keys.length - 1 && tree && findNodeAtLocation(tree, keys.slice(0, depth + 1))) {
    depth += 1;
  }

  const nested = keys
    .slice(depth + 1)
    .reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);

  const [edit] = modify(before, [...keys], value, {});

  if (!edit) return before;

  const unit = indentUnit(before);
  const indent = unit.repeat(depth + 1);
  const body = `${JSON.stringify(keys[depth])}: ${JSON.stringify(nested, null, unit)}`
    .split('\n')
    .join(`\n${indent}`);

  let offset = edit.offset + edit.length;
  let lead = edit.content.startsWith(',') ? ',' : '';
  let trail = '';
  const trailingComma = /^[ \t]*,[ \t]*(?:\/\/[^\n]*)?/.exec(before.slice(offset));

  if (lead && trailingComma) {
    offset += trailingComma[0].length;
    lead = '';
    trail = ',';
  }

  const rest = before.slice(offset);
  const close = /^[ \t]*(?:\/\/[^\n]*)?\r?\n/.test(rest) ? '' : `\n${unit.repeat(depth)}`;

  return `${before.slice(0, edit.offset)}${before.slice(edit.offset + edit.length, offset)}${lead}\n${indent}${body}${trail}${close}${rest}`;
}

function collapseEmpty(text: string, keys: readonly string[]) {
  const tree = parseTree(text);
  const parent = tree && findNodeAtLocation(tree, keys.slice(0, -1));

  if (!parent || parent.type !== 'object' || parent.children?.length) return text;

  const inside = text.slice(parent.offset + 1, parent.offset + parent.length - 1);

  if (inside.trim()) return text;

  return `${text.slice(0, parent.offset)}{}${text.slice(parent.offset + parent.length)}`;
}

function cutJson(before: string, keys: readonly string[]) {
  const tree = parseTree(before);
  const property = tree && findNodeAtLocation(tree, [...keys])?.parent;
  const siblings = property?.parent?.children;

  if (!property || !siblings) return undefined;

  const end = property.offset + property.length;
  const lineStart = before.lastIndexOf('\n', property.offset - 1) + 1;
  const after = /^[ \t]*,?[ \t]*\r?\n/.exec(before.slice(end));

  if (lineStart === 0 || before.slice(lineStart, property.offset).trim() || !after) {
    return undefined;
  }

  if (after[0].includes(',')) {
    return `${before.slice(0, lineStart)}${before.slice(end + after[0].length)}`;
  }

  const index = siblings.indexOf(property);
  const previous = siblings[index - 1];

  if (!previous) return `${before.slice(0, lineStart - 1)}${before.slice(end)}`;

  const previousEnd = previous.offset + previous.length;
  const comma = /^[ \t]*,/.exec(before.slice(previousEnd));

  if (!comma) return undefined;

  return `${before.slice(0, previousEnd)}${before.slice(previousEnd + comma[0].length, lineStart - 1)}${before.slice(end)}`;
}

function removeJson(before: string, keys: readonly string[], dropParent: boolean) {
  const cut = cutJson(before, keys) ?? applyEdits(before, modify(before, [...keys], undefined, {}));
  const collapsed = collapseEmpty(cut, keys);
  const tree = parseTree(collapsed);
  const parent = tree && findNodeAtLocation(tree, keys.slice(0, -1));

  if (!dropParent || keys.length < 2 || parent?.type !== 'object' || parent.children?.length) {
    return collapsed;
  }

  const parentKeys = keys.slice(0, -1);
  const dropped = cutJson(collapsed, parentKeys);

  return dropped === undefined ? collapsed : collapseEmpty(dropped, parentKeys);
}

function backupLacksParent(entry: ConfigEntry) {
  try {
    const parsed = parseConfig(
      fs.readFileSync(`${entry.file}${BACKUP_SUFFIX}`, 'utf8'),
      entry.format,
    );

    return parsed.ok && lookup(parsed.config, entry.path.slice(0, -1)).value === undefined;
  } catch {
    return false;
  }
}

function tomlBlock(entry: ConfigEntry) {
  const lines = Object.entries(entry.value).map(
    ([key, value]) => `${key} = ${JSON.stringify(value)}`,
  );

  return `[${entry.path.join('.')}]\n${lines.join('\n')}\n`;
}

function insertToml(before: string, block: string) {
  if (!before) return block;

  if (before.endsWith('\n\n')) return `${before}${block}`;

  return `${before}${before.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

function tableRange(before: string, keys: readonly string[]) {
  const header = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\.');
  const match = new RegExp(`^\\[${header}\\][ \t]*(?:#[^\\n]*)?(?:\\n|$)`, 'm').exec(before);

  if (!match) return undefined;

  const body = match.index + match[0].length;
  const next = /^[ \t]*\[/m.exec(before.slice(body));
  const lines = before.slice(body, next ? body + next.index : before.length).split('\n');

  while (lines.length > 1 && /^[ \t]*(?:#.*)?$/.test(lines[lines.length - 2] ?? '')) {
    lines.splice(lines.length - 2, 1);
  }

  return { start: match.index, end: body + lines.join('\n').length };
}

function removeToml(before: string, block: string, keys: readonly string[]) {
  const exact = before.indexOf(block);
  const range =
    exact !== -1 && before.indexOf(block, exact + 1) === -1
      ? { start: exact, end: exact + block.length }
      : tableRange(before, keys);

  if (!range) return undefined;

  const { start, end } = range;
  const from = start >= 2 && before.slice(start - 2, start) === '\n\n' ? start - 1 : start;

  return `${before.slice(0, from)}${before.slice(end)}`;
}

function expectedAfter(entry: ConfigEntry, config: Record<string, unknown>, remove: boolean) {
  const next = structuredClone(plain(config)) as Record<string, unknown>;
  const keys = entry.path;
  let container = next;

  for (const key of keys.slice(0, -1)) {
    if (!isObject(container[key])) container[key] = {};

    container = container[key] as Record<string, unknown>;
  }

  const last = keys[keys.length - 1] ?? '';

  if (remove) delete container[last];
  else container[last] = plain(entry.value);

  return next;
}

function withoutEmptyParent(config: unknown, keys: readonly string[]) {
  const copy = structuredClone(config) as Record<string, unknown>;
  const parent = lookup(copy, keys.slice(0, -1)).value;

  if (isObject(parent) && Object.keys(parent).length === 0 && keys.length > 1) {
    const owner = lookup(copy, keys.slice(0, -2)).value;

    if (isObject(owner)) delete owner[keys[keys.length - 2] ?? ''];
  }

  return copy;
}

function backupOnce(file: string) {
  const backup = `${file}${BACKUP_SUFFIX}`;

  if (fs.existsSync(backup)) return undefined;

  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, fs.statSync(file).mode & 0o777);

  return backup;
}

function writeAtomic(file: string, before: string | undefined, after: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (before !== undefined && fs.readFileSync(file, 'utf8') !== before) {
    throw new Error(`${file} changed while Sidekick was editing it; try again`);
  }

  const mode = before === undefined ? 0o600 : fs.statSync(file).mode & 0o777;
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, after, { mode, flag: 'wx' });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Adds the entry, or with `remove` takes it out again, keeping comments, formatting and every
 * other server. It never changes an entry it didn't write, and leaves a file it can't parse alone.
 */
export function editConfig(target: ConfigEntry, remove = false): EditResult {
  const exists = fs.existsSync(target.file);

  if (!exists && remove) return { result: 'unchanged' };

  const entry = exists ? { ...target, file: fs.realpathSync(target.file) } : target;
  const before = exists ? fs.readFileSync(entry.file, 'utf8') : undefined;
  const blank = entry.format === 'json' && !before?.trim();
  const text = blank ? '{}' : (before ?? '');
  const state = inspect(entry, text);

  if (state === 'invalid') return { result: 'invalid' };

  if (state === 'other') return { result: 'conflict' };

  if (remove ? state === 'absent' : state === 'owned') return { result: 'unchanged' };

  let after: string | undefined;

  if (entry.format === 'toml') {
    const block = tomlBlock(entry);

    after = remove ? removeToml(text, block, entry.path) : insertToml(text, block);
  } else {
    after = remove
      ? removeJson(text, entry.path, backupLacksParent(entry))
      : `${insertJson(text, entry.path, entry.value)}${blank ? '\n' : ''}`;
  }

  const parsedBefore = parseConfig(text, entry.format);
  const parsedAfter = after === undefined ? undefined : parseConfig(after, entry.format);

  if (
    after === undefined ||
    !parsedBefore.ok ||
    !parsedAfter?.ok ||
    !isDeepStrictEqual(
      withoutEmptyParent(plain(parsedAfter.config), entry.path),
      withoutEmptyParent(expectedAfter(entry, parsedBefore.config, remove), entry.path),
    )
  ) {
    return { result: 'refused' };
  }

  const backup = exists ? backupOnce(entry.file) : undefined;

  writeAtomic(entry.file, before, after);

  return { result: remove ? 'removed' : 'added', ...(backup ? { backup } : {}) };
}

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encode, frames, receiveRun, type RunMessage, safeName } from './runs.js';

let dir: string;

function from<T>(items: T[]): AsyncIterable<T> {
  return Readable.from(items);
}

async function collect(input: AsyncIterable<unknown>) {
  const out: unknown[] = [];

  for await (const message of input) out.push(message);

  return out;
}

const run = (name: string, key: string, ...texts: string[]): RunMessage[] => [
  { type: 'open', name, key },
  ...texts.map((text): RunMessage => ({ type: 'chunk', text })),
  { type: 'close' },
];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sidekick-runs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('safeName', () => {
  it.each(['../x.json', 'a/b.json', 'x.txt', '.json', 'a\\b.json', 'a..json', ''])(
    'refuses %j',
    (name) => {
      expect(safeName(name)).toBe(false);
    },
  );

  it('accepts a plain run name', () => {
    expect(safeName('2026-10-24-fix-dns_records-k3v9x2ab.json')).toBe(true);
  });
});

describe('frames', () => {
  it('reads messages split across and packed into chunks', async () => {
    const bytes = Buffer.concat([encode({ a: 'é' }), encode({ type: 'close' })]);
    const pieces = [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)];

    expect(await collect(frames(from(pieces)))).toEqual([{ a: 'é' }, { type: 'close' }]);
  });
});

describe('receiveRun', () => {
  it('refuses unsafe names and keys, and writes nothing', async () => {
    for (const name of ['../x.json', 'a/b.json', 'x.txt', '.json']) {
      expect(await receiveRun(dir, from(run(name, 'k3v9x2ab', '{}')))).toMatchObject({
        ok: false,
      });
    }

    expect(await receiveRun(dir, from(run('a.json', '../k', '{}')))).toMatchObject({ ok: false });
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(path.dirname(dir))).not.toContain('x.json');
  });

  it('writes the chunks to a temp file, then renames it into place', async () => {
    const target = path.join(dir, '2026-10-24-a-k1.json');
    const input = (async function* () {
      yield { type: 'open', name: '2026-10-24-a-k1.json', key: 'k1' };
      yield { type: 'chunk', text: '{"a":' };

      const names = await readdir(dir);

      expect(names).toEqual([`2026-10-24-a-k1.json.${process.pid}.tmp`]);

      yield { type: 'chunk', text: '1}\n' };
      yield { type: 'close' };
    })();

    expect(await receiveRun(dir, input)).toEqual({ ok: true, file: '2026-10-24-a-k1.json' });
    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n');
    expect(await readdir(dir)).toEqual(['2026-10-24-a-k1.json']);
  });

  it('keeps the first name for a key, overwriting it whole', async () => {
    await receiveRun(dir, from(run('2026-10-24-untitled-k1.json', 'k1', 'first, longer')));
    await writeFile(path.join(dir, '2026-10-24-other-k2.json'), 'other');

    expect(await receiveRun(dir, from(run('2026-10-24-renamed-k1.json', 'k1', 'second')))).toEqual({
      ok: true,
      file: '2026-10-24-untitled-k1.json',
    });

    expect((await readdir(dir)).sort()).toEqual([
      '2026-10-24-other-k2.json',
      '2026-10-24-untitled-k1.json',
    ]);

    expect(await readFile(path.join(dir, '2026-10-24-untitled-k1.json'), 'utf8')).toBe('second');
  });

  it('leaves no temp file when input ends before close', async () => {
    const reply = await receiveRun(
      dir,
      from([
        { type: 'open', name: 'a-k1.json', key: 'k1' },
        { type: 'chunk', text: '{' },
      ]),
    );

    expect(reply).toEqual({ ok: false, error: 'Input ended before close' });
    expect(await readdir(dir)).toEqual([]);
  });
});

import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** What the panel sends: `open`, then `chunk`s of the file's text, then `close`. */
export type RunMessage =
  { type: 'open'; name: string; key: string } | { type: 'chunk'; text: string } | { type: 'close' };

/** The host's one reply; `file` is the name it wrote, which may be an earlier run's. */
export type RunReply = { ok: true; file: string } | { ok: false; error: string };

const NAME = /^[A-Za-z0-9][\w.-]*\.json$/;

const KEY = /^[A-Za-z0-9]+$/;

/** Whether `name` is a plain `.json` file name: no folder, no `..`, no leading dot. */
export function safeName(name: string) {
  return NAME.test(name) && !name.includes('..');
}

/** Chrome's framing: a 4-byte length in native (little-endian) order, then UTF-8 JSON. */
export function encode(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);

  head.writeUInt32LE(body.length, 0);

  return Buffer.concat([head, body]);
}

/** The messages in a framed stream, such as the host's stdin. */
export async function* frames(input: AsyncIterable<Buffer | string>): AsyncGenerator<unknown> {
  let pending: Buffer[] = [];
  let length = 0;
  let size: number | undefined;

  const flat = () => {
    if (pending.length > 1) pending = [Buffer.concat(pending, length)];

    return pending[0] ?? Buffer.alloc(0);
  };

  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

    pending.push(buffer);
    length += buffer.length;

    for (;;) {
      if (size === undefined) {
        if (length < 4) break;

        size = flat().readUInt32LE(0);
      }

      if (length < 4 + size) break;

      const all = flat();
      const rest = all.subarray(4 + size);

      yield JSON.parse(all.subarray(4, 4 + size).toString('utf8'));

      pending = rest.length ? [rest] : [];
      length = rest.length;
      size = undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parse(value: unknown): RunMessage | undefined {
  if (!isRecord(value)) return undefined;

  if (value.type === 'open' && typeof value.name === 'string' && typeof value.key === 'string') {
    return { type: 'open', name: value.name, key: value.key };
  }

  if (value.type === 'chunk' && typeof value.text === 'string') {
    return { type: 'chunk', text: value.text };
  }

  return value.type === 'close' ? { type: 'close' } : undefined;
}

async function existing(dir: string, key: string) {
  const suffix = `-${key}.json`;
  const names = await readdir(dir).catch(() => []);

  return names.find((name) => name.endsWith(suffix) && safeName(name));
}

/**
 * Writes one run into `dir`, atomically: chunks stream into `<name>.<pid>.tmp`, renamed on `close`.
 * A run whose key already has a file keeps that file's name, so the name is fixed at the first
 * write. Input that ends before `close` leaves nothing behind.
 */
export async function receiveRun(dir: string, input: AsyncIterable<unknown>): Promise<RunReply> {
  const messages = input[Symbol.asyncIterator]();
  const first = parse((await messages.next()).value);

  if (first?.type !== 'open') return { ok: false, error: 'Expected open' };

  if (!safeName(first.name)) return { ok: false, error: `Not a plain .json name: ${first.name}` };

  if (!KEY.test(first.key)) return { ok: false, error: `Not a plain key: ${first.key}` };

  await mkdir(dir, { recursive: true });

  const file = (await existing(dir, first.key)) ?? first.name;
  const target = path.join(dir, file);
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w');
  let closed = false;

  try {
    for (let next = await messages.next(); !next.done; next = await messages.next()) {
      const message = parse(next.value);

      if (message?.type === 'chunk') await handle.appendFile(message.text);
      else if (message?.type === 'close') {
        closed = true;
        break;
      } else return { ok: false, error: 'Expected chunk or close' };
    }
  } finally {
    await handle.close();

    if (!closed) await rm(temporary, { force: true });
  }

  if (!closed) return { ok: false, error: 'Input ended before close' };

  await rename(temporary, target);

  return { ok: true, file };
}

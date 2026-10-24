import type { ExportReader, SessionInfo } from '@frogbotai/sidekick-core';
import { describe, expect, it } from 'vitest';

import { chunks, type RunPort, runSaver } from './runs';

type Reader = Required<ExportReader>;

function info(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    agent: 'build',
    model: 'openai/gpt-5',
    created: new Date(2026, 9, 24, 9).getTime(),
    updated: 1,
    ...extra,
  };
}

function reader(sessions: SessionInfo[], text = 'hi'): Reader {
  return {
    sessions: {
      get: (id) => Promise.resolve(sessions.find((session) => session.id === id)),
      list: ({ parentID } = {}) =>
        Promise.resolve(sessions.filter((session) => session.parentID === parentID)),
    },
    messages: (sessionID) =>
      Promise.resolve([
        {
          id: `msg_${sessionID}`,
          sessionID,
          seq: 1,
          type: 'user',
          time: { created: 1 },
          parts: [{ type: 'text', text }],
        },
      ]),
    events: () => Promise.resolve([]),
  };
}

interface FakePort extends RunPort {
  sent: unknown[];
  reply: (message: unknown) => void;
  drop: () => void;
}

function fakePort(auto?: unknown): FakePort {
  const onMessage: ((message: unknown) => void)[] = [];
  const onDisconnect: (() => void)[] = [];

  const port: FakePort = {
    sent: [],
    postMessage: (message) => {
      port.sent.push(message);

      if (auto && (message as { type: string }).type === 'close') {
        queueMicrotask(() => port.reply(auto));
      }
    },
    disconnect: () => undefined,
    onMessage: { addListener: (listener) => void onMessage.push(listener) },
    onDisconnect: { addListener: (listener) => void onDisconnect.push(listener) },
    reply: (message) => {
      for (const listener of onMessage) listener(message);
    },
    drop: () => {
      for (const listener of onDisconnect) listener();
    },
  };

  return port;
}

const OK = { ok: true, file: 'x.json' };

describe('runSaver', () => {
  it('saves a child’s idle as its root’s file, with the children and the event log', async () => {
    const ports: FakePort[] = [];
    const saver = runSaver({
      reader: reader([
        info('ses_root0000k3v9x2ab', { title: 'Fix DNS' }),
        info('ses_child', { parentID: 'ses_root0000k3v9x2ab' }),
        info('ses_grand', { parentID: 'ses_child' }),
      ]),
      connect: () => {
        const port = fakePort(OK);

        ports.push(port);

        return port;
      },
      warn: () => {
        throw new Error('no warning expected');
      },
    });

    saver.save('ses_grand');
    await saver.settled();

    const [port] = ports;
    const [open, ...rest] = port?.sent ?? [];
    const text = rest.flatMap((message) => {
      const { type, text: chunk } = message as { type: string; text?: string };

      return type === 'chunk' && chunk ? [chunk] : [];
    });

    const file = JSON.parse(text.join('')) as {
      sessions: { info: { id: string }; events?: unknown[] }[];
    };

    expect(ports).toHaveLength(1);

    expect(open).toEqual({
      type: 'open',
      name: '2026-10-24-fix-dns-k3v9x2ab.json',
      key: 'k3v9x2ab',
    });

    expect(rest.at(-1)).toEqual({ type: 'close' });

    expect(file.sessions.map(({ info: { id } }) => id)).toEqual([
      'ses_root0000k3v9x2ab',
      'ses_child',
      'ses_grand',
    ]);

    expect(file.sessions[0]?.events).toEqual([]);
  });

  it('folds two idles during one write into one more write, and never makes the turn wait', async () => {
    const ports: FakePort[] = [];
    const saver = runSaver({
      reader: reader([info('ses_a'), info('ses_b', { parentID: 'ses_a' })]),
      connect: () => {
        const port = fakePort();

        ports.push(port);

        return port;
      },
    });

    expect(saver.save('ses_a')).toBeUndefined();

    await expect.poll(() => ports.length).toBe(1);

    saver.save('ses_b');
    saver.save('ses_a');
    await new Promise((resolve) => setTimeout(resolve, 0));

    ports[0]?.reply(OK);

    await expect.poll(() => ports.length).toBe(2);

    ports[1]?.reply(OK);
    await saver.settled();

    expect(ports).toHaveLength(2);
  });

  it('warns once per panel when the writer is missing, refuses, or can’t be opened', async () => {
    const warnings: string[] = [];
    const attempts = [
      () => {
        const port = fakePort();

        queueMicrotask(() => port.drop());

        return port;
      },
      () => fakePort({ ok: false, error: 'Not a plain .json name' }),
      () => {
        throw new TypeError('chrome.runtime.connectNative is not a function');
      },
    ];

    const saver = runSaver({
      reader: reader([info('ses_a')]),
      connect: () => attempts.shift()?.() ?? fakePort(OK),
      warn: (message) => void warnings.push(message),
    });

    for (let index = 0; index < 3; index++) {
      saver.save('ses_a');
      await saver.settled();
    }

    expect(warnings).toEqual([
      'Sidekick didn’t save this run to .idea/runs: the writer disconnected',
    ]);
  });
});

describe('chunks', () => {
  it('packs newline-ended lines into chunks under the limit, splitting a long line', () => {
    const lines = ['aaaa', 'bb', 'c'.repeat(23), 'd'];
    const packed = chunks(lines, 10);

    expect(packed.join('')).toBe(lines.map((line) => `${line}\n`).join(''));
    expect(packed.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(packed[0]).toBe('aaaa\nbb\n');
  });

  it('keeps a real run’s chunks under the limit', async () => {
    const big = 'x'.repeat(3000);
    const ports: FakePort[] = [];
    const saver = runSaver({
      reader: reader([info('ses_a')], big),
      connect: () => {
        const port = fakePort(OK);

        ports.push(port);

        return port;
      },
      chunkChars: 1000,
    });

    saver.save('ses_a');
    await saver.settled();

    const sent = (ports[0]?.sent ?? []) as { type: string; text?: string }[];
    const texts = sent.flatMap(({ text }) => (text === undefined ? [] : [text]));

    expect(texts.length).toBeGreaterThan(3);
    expect(texts.every((text) => text.length <= 1000)).toBe(true);
    expect(texts.join('')).toContain(big);
  });
});

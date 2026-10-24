import { exportLines, type ExportReader, runFileName, runKey } from '@frogbotai/sidekick-core';

/** The run writer's native-messaging host, which `pnpm dev` registers. */
export const RUNS_HOST = 'ai.frogbot.sidekick_runs';

/**
 * The most UTF-16 code units in one chunk message. Each encodes to at most 3 bytes of UTF-8, so a
 * chunk stays under 4 MiB, far below Chrome's 64 MiB per message to a host.
 */
export const CHUNK_CHARS = 1 << 20;

/** The part of a `chrome.runtime.Port` the saver uses. */
export interface RunPort {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
}

export interface RunSaverOptions {
  /** The panel's store; runs keep their event log (328 D2). */
  reader: Required<ExportReader>;
  /** Opens the writer; `chrome.runtime.connectNative` by default. */
  connect?: () => RunPort;
  warn?: (message: string) => void;
  chunkChars?: number;
}

export interface RunSaver {
  /** Saves the root of `sessionID`'s chat in the background; never throws, never waits. */
  save: (sessionID: string) => void;
  /** Resolves once every save started so far has ended. */
  settled: () => Promise<void>;
}

/** The lines, newline-terminated, packed into chunks of at most `limit` characters. */
export function chunks(lines: readonly string[], limit = CHUNK_CHARS) {
  const out: string[] = [];
  let current = '';

  for (const line of lines) {
    let text = `${line}\n`;

    if (current.length + text.length > limit && current) {
      out.push(current);
      current = '';
    }

    while (text.length > limit) {
      out.push(text.slice(0, limit));
      text = text.slice(limit);
    }

    current += text;
  }

  if (current) out.push(current);

  return out;
}

function lastError() {
  return typeof chrome === 'undefined' ? undefined : chrome.runtime.lastError?.message;
}

function send(port: RunPort, messages: readonly unknown[]) {
  return new Promise<void>((resolve, reject) => {
    port.onMessage.addListener((reply) => {
      port.disconnect();

      const ok = typeof reply === 'object' && reply !== null && 'ok' in reply && reply.ok === true;
      const error =
        typeof reply === 'object' && reply !== null && 'error' in reply
          ? String(reply.error)
          : 'the writer refused the run';

      if (ok) resolve();
      else reject(new Error(error));
    });

    port.onDisconnect.addListener(() => {
      reject(new Error(lastError() ?? 'the writer disconnected'));
    });

    try {
      for (const message of messages) port.postMessage(message);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Saves each finished run to `.idea/runs` through the local writer, for `pnpm dev` builds: the root
 * session's file, children inside, rewritten whole. Saves for a root that come while it is being
 * written fold into one more write. A missing or failing writer logs one warning per panel.
 */
export function runSaver({
  reader,
  connect = () => chrome.runtime.connectNative(RUNS_HOST),
  // eslint-disable-next-line no-console -- spec 9: a failed writer logs one warning per panel
  warn = (message) => console.warn(message),
  chunkChars = CHUNK_CHARS,
}: RunSaverOptions): RunSaver {
  const again = new Map<string, boolean>();
  const pending = new Set<Promise<void>>();
  let warned = false;

  const rootOf = async (sessionID: string) => {
    let info = await reader.sessions.get(sessionID);

    while (info?.parentID) info = await reader.sessions.get(info.parentID);

    return info;
  };

  const write = async (rootID: string) => {
    const info = await reader.sessions.get(rootID);

    if (!info) return;

    const lines = await exportLines(reader, [info], { events: true });
    const messages = [
      { type: 'open', name: runFileName(info), key: runKey(info) },
      ...chunks(lines, chunkChars).map((text) => ({ type: 'chunk', text })),
      { type: 'close' },
    ];

    await send(connect(), messages);
  };

  const run = async (sessionID: string) => {
    const root = await rootOf(sessionID);

    if (!root) return;

    if (again.has(root.id)) {
      again.set(root.id, true);

      return;
    }

    again.set(root.id, false);

    try {
      do {
        again.set(root.id, false);
        await write(root.id);
      } while (again.get(root.id));
    } finally {
      again.delete(root.id);
    }
  };

  return {
    save: (sessionID) => {
      const saving = run(sessionID).catch((error: unknown) => {
        if (warned) return;

        warned = true;

        warn(
          `Sidekick didn’t save this run to .idea/runs: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      pending.add(saving);
      void saving.finally(() => pending.delete(saving));
    },
    settled: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

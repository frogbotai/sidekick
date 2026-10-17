import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Sidekick's last answers to the handshake and `tools/list`, so a client starts without a tab. */
export interface Cached {
  /** The `protocolVersion` the client asked for, which the cached `initialize` answered. */
  protocolVersion?: string;
  initialize?: unknown;
  tools?: unknown;
}

export interface Cache {
  read: () => Promise<Cached>;
  write: (change: Partial<Cached>) => Promise<void>;
}

/** The OS cache folder: `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows, XDG elsewhere. */
export function cacheRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches');

  if (platform === 'win32') return env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  return env.XDG_CACHE_HOME ?? path.join(home, '.cache');
}

/** One file per extension and token, so pairings and dev builds never share answers. */
export function cacheFile(root: string, extensionId: string, token: string | undefined) {
  const key = createHash('sha256')
    .update(`${extensionId} ${token ?? ''}`)
    .digest('hex')
    .slice(0, 32);

  return path.join(root, 'sidekick-mcp', `${key}.json`);
}

function parse(text: string): Cached {
  const value: unknown = JSON.parse(text);

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const { protocolVersion, initialize, tools } = value as Record<string, unknown>;

  return {
    ...(typeof protocolVersion === 'string' ? { protocolVersion } : {}),
    ...(initialize === undefined ? {} : { initialize }),
    ...(tools === undefined ? {} : { tools }),
  };
}

/** A JSON file, written whole through a temporary file; a missing or broken one reads as empty. */
export function fileCache(file: string): Cache {
  let current: Promise<Cached> | undefined;

  const read = () => {
    current ??= readFile(file, 'utf8')
      .then(parse)
      .catch(() => ({}));

    return current;
  };

  return {
    read,
    write: async (change) => {
      const next = { ...(await read()), ...change };

      current = Promise.resolve(next);

      try {
        await mkdir(path.dirname(file), { recursive: true });

        const temporary = `${file}.${process.pid}.tmp`;

        await writeFile(temporary, JSON.stringify(next));
        await rename(temporary, file);
      } catch {
        return;
      }
    },
  };
}

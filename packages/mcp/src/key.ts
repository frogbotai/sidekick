import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** This computer's pairing with Sidekick, which every agent's helper shares. */
export interface PairingKey {
  key: string;
  pairingID: string;
  computer: string;
}

/** `%APPDATA%\sidekick\pairing.json` on Windows, else `$XDG_CONFIG_HOME/sidekick/pairing.json`. */
export function keyFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (platform === 'win32') {
    return path.win32.join(
      env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'),
      'sidekick',
      'pairing.json',
    );
  }

  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'sidekick', 'pairing.json');
}

function parse(text: string): PairingKey | undefined {
  const value: unknown = JSON.parse(text);

  if (typeof value !== 'object' || value === null) return undefined;

  const { key, pairingID, computer } = value as Record<string, unknown>;

  if (typeof key !== 'string' || !key) return undefined;

  return {
    key,
    pairingID: typeof pairingID === 'string' ? pairingID : '',
    computer: typeof computer === 'string' ? computer : '',
  };
}

/** The pairing, or undefined when the file is missing or broken. */
export async function readKey(file = keyFile()) {
  try {
    return parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Writes the pairing readable by this user only, whole, through a temporary file. */
export async function writeKey(value: PairingKey, file = keyFile()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  const temporary = `${file}.${process.pid}.tmp`;

  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The token the helper connects with: `SIDEKICK_TOKEN` when set, else this computer's pairing. */
export async function helperToken(
  env: NodeJS.ProcessEnv = process.env,
  file = keyFile(process.platform, env),
) {
  if (env.SIDEKICK_TOKEN) return env.SIDEKICK_TOKEN;

  return (await readKey(file))?.key;
}

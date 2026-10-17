import { spawn } from 'node:child_process';
import path from 'node:path';

/** The page Sidekick opens for a helper: its hub, and the token that names the pairing. */
export function connectUrl({
  extensionId,
  hub,
  token,
}: {
  extensionId: string;
  hub: string;
  token: string | undefined;
}) {
  const url = new URL(`chrome-extension://${extensionId}/connect.html`);

  url.searchParams.set('hub', hub);

  if (token) url.searchParams.set('token', token);

  return url.href;
}

/** The Chrome that wakes Sidekick: `SIDEKICK_CHROME`, else Google Chrome where it installs. */
export function chromeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.SIDEKICK_CHROME) return env.SIDEKICK_CHROME;

  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  if (platform === 'win32') {
    return path.win32.join(
      env.PROGRAMFILES ?? 'C:\\Program Files',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe',
    );
  }

  return 'google-chrome';
}

/**
 * Opens `url` in Chrome, the way Playwright's extension mode does: a running Chrome takes the URL
 * and the new process exits; otherwise Chrome starts with it.
 */
export function wake(url: string, executable = chromeExecutable()) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: true });

    child.once('error', reject);

    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

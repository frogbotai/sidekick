import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { build } from 'vite';

const PAGES = path.resolve(import.meta.dirname, 'fixtures');

const BUNDLES = path.resolve(import.meta.dirname, '../.output/e2e-fixtures');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function buildEditors() {
  await build({
    configFile: false,
    logLevel: 'warn',
    root: PAGES,
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    build: {
      outDir: BUNDLES,
      emptyOutDir: true,
      lib: {
        entry: path.join(PAGES, 'editors/index.tsx'),
        formats: ['es'],
        fileName: () => 'editors.js',
      },
    },
  });
}

function fileFor(pathname: string) {
  const name = path.posix.normalize(pathname).replace(/^\/+/, '');

  if (name.includes('..')) return undefined;

  return name.startsWith('bundles/') ? path.join(BUNDLES, name.slice(8)) : path.join(PAGES, name);
}

function listen(server: Server, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);

    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Serves `e2e/fixtures` and the editor bundle on one port, reached as `localhost` and `127.0.0.1`
 * (two origins), and on IPv4 alone where the machine has no IPv6, as some cloud containers don't;
 * `/redirect?to=<url>` answers 302, and `/redirect?other=<path>` redirects to that path on
 * `127.0.0.1`.
 */
export default async function setup() {
  await buildEditors();

  const server = createServer((request, response) => {
    const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');
    const to = searchParams.get('to');

    const other = searchParams.get('other');
    const port = request.headers.host?.split(':').pop();

    if (pathname === '/redirect' && to) return void response.writeHead(302, { location: to }).end();

    if (pathname === '/redirect' && other?.startsWith('/')) {
      return void response.writeHead(302, { location: `http://127.0.0.1:${port}${other}` }).end();
    }

    const file = fileFor(pathname === '/' ? '/index.html' : pathname);

    if (!file) return void response.writeHead(400).end();

    readFile(file).then(
      (body) => {
        response.writeHead(200, {
          'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });

        response.end(body);
      },
      () => response.writeHead(404).end('not found'),
    );
  });

  await listen(server, '::').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EAFNOSUPPORT') throw error;

    return listen(server, '127.0.0.1');
  });

  const { port } = server.address() as AddressInfo;

  process.env.SIDEKICK_FIXTURE_PORT = String(port);

  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

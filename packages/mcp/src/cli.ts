#!/usr/bin/env node
import { createInterface } from 'node:readline';

import { cacheFile, cacheRoot, fileCache } from './cache.js';
import { startHub, STORE_EXTENSION_ID } from './hub.js';
import { createRelay, type Message, type Relay } from './relay.js';
import { connectUrl, wake } from './wake.js';

const token = process.env.SIDEKICK_TOKEN || undefined;
const extensionId = process.env.SIDEKICK_EXTENSION_ID || STORE_EXTENSION_ID;

let relay: Relay | undefined;

const hub = await startHub({ token, extensionId, onSocket: (socket) => relay?.attach(socket) });

relay = createRelay({
  cache: fileCache(cacheFile(cacheRoot(), extensionId, token)),
  hasToken: token !== undefined,
  send: (message) => void process.stdout.write(`${JSON.stringify(message)}\n`),
  wake: async () => {
    try {
      await wake(connectUrl({ extensionId, hub: hub.url, token }));
    } catch (error) {
      process.stderr.write(`sidekick-mcp: couldn’t open Chrome: ${String(error)}\n`);
    }
  },
});

const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  if (!line.trim()) return;

  try {
    relay?.fromClient(JSON.parse(line) as Message);
  } catch {
    process.stderr.write('sidekick-mcp: ignored a line that wasn’t JSON\n');
  }
});

const stop = async () => {
  relay?.close();
  await hub.close();
  process.exit(0);
};

lines.on('close', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

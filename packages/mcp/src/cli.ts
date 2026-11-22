#!/usr/bin/env node
import { COMMANDS } from './install/commands.js';

const [command, ...args] = process.argv.slice(2);
const subcommand = COMMANDS.find((name) => name === command);

if (subcommand) {
  const { run } = await import('./install/run.js');

  process.exitCode = await run(subcommand, args);
} else {
  await import('./server.js');
}

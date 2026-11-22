import { keyFile } from '../key.js';
import { currentEnvironment } from './agents.js';
import { type CommandName, runCommand } from './commands.js';
import { chromePairing } from './pair.js';
import { pickAgents } from './picker.js';

/** Runs a subcommand on this computer, writing to the terminal. */
export function run(name: CommandName, args: readonly string[]) {
  return runCommand(name, args, {
    environment: currentEnvironment(),
    keyFile: keyFile(),
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    log: (line) => void process.stdout.write(`${line}\n`),
    pick: pickAgents,
    pairing: chromePairing(),
  });
}

import { readKey } from '../key.js';
import {
  AGENT_NAMES,
  type AgentLocation,
  agentLocations,
  type AgentName,
  callingAgent,
  COMMAND,
  type Environment,
  SERVER,
} from './agents.js';
import { editConfig, type EditResult, readEntry } from './browse/edit.js';
import { agentFlags, agentPlan } from './plan.js';

/** The subcommands of the helper's bin. */
export const COMMANDS = ['install', 'uninstall', 'status'] as const;

export type CommandName = (typeof COMMANDS)[number];

/** Everything a command reads or writes outside the agents' config files. Tests pass their own. */
export interface CommandIO {
  environment: Environment;
  keyFile: string;
  tty: boolean;
  log: (line: string) => void;
  pick: (
    agents: readonly AgentLocation[],
    initial: AgentName[],
  ) => Promise<AgentName[] | undefined>;
}

const INSTALL = `${COMMAND.join(' ')} install`;

function edit(agent: AgentLocation, remove: boolean): EditResult | Error {
  try {
    return editConfig(agent.entry, remove);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function choose(args: readonly string[], agents: AgentLocation[], io: CommandIO) {
  const plan = agentPlan(agents, agentFlags(args), io.tty, callingAgent(io.environment.env));

  if (!plan.picker) return plan.selected;

  return io.pick(agents, plan.selected);
}

async function pairingLine(io: CommandIO) {
  if (await readKey(io.keyFile)) return 'Sidekick is paired on this computer.';

  return `Pairing is pending: run \`${INSTALL}\` again to pair with Sidekick in Chrome.`;
}

async function install(args: readonly string[], io: CommandIO) {
  const agents = agentLocations(io.environment);
  const selected = await choose(args, agents, io);

  if (selected === undefined) {
    io.log('Cancelled. Nothing was written.');

    return 1;
  }

  if (!selected.length) {
    io.log('No agent was named, and none is running this command, so nothing was written.');
    io.log(`Name the agents: ${INSTALL} -a ${AGENT_NAMES.join(' ')}`);

    return 0;
  }

  let failed = false;
  const added: string[] = [];

  for (const agent of agents.filter(({ name }) => selected.includes(name))) {
    const { label, entry } = agent;
    const outcome = edit(agent, false);

    if (outcome instanceof Error) {
      failed = true;
      io.log(`✗ ${label}: ${outcome.message}`);
      continue;
    }

    if (outcome.result === 'added') {
      added.push(label);
      io.log(`✓ ${label}: added ${SERVER} to ${entry.file}`);

      if (outcome.backup) io.log(`  Backup of the original: ${outcome.backup}`);
    } else if (outcome.result === 'unchanged') {
      io.log(`✓ ${label}: already set up in ${entry.file}`);
    } else if (outcome.result === 'conflict') {
      io.log(`! ${label}: ${entry.file} already has its own "${SERVER}" entry, left as is`);
    } else {
      failed = true;
      io.log(`✗ ${label}: couldn’t read ${entry.file}, left unchanged`);
    }
  }

  if (!added.length && !failed) io.log('Nothing to change.');

  if (added.length) io.log(`Restart ${added.join(', ')} to load Sidekick.`);

  io.log(await pairingLine(io));

  return failed ? 1 : 0;
}

async function uninstall(args: readonly string[], io: CommandIO) {
  const { requested } = agentFlags(args);
  const agents = agentLocations(io.environment).filter(
    ({ name }) => !requested.length || requested.includes(name),
  );

  let failed = false;
  let removed = 0;

  for (const agent of agents) {
    const { label, entry } = agent;
    const outcome = edit(agent, true);

    if (outcome instanceof Error) {
      failed = true;
      io.log(`✗ ${label}: ${outcome.message}`);
    } else if (outcome.result === 'removed') {
      removed += 1;
      io.log(`✓ ${label}: removed ${SERVER} from ${entry.file}`);

      if (outcome.backup) io.log(`  Backup of the original: ${outcome.backup}`);
    } else if (outcome.result === 'conflict') {
      io.log(`! ${label}: its "${SERVER}" entry isn’t one install wrote, left as is`);
    } else if (outcome.result === 'invalid') {
      failed = true;
      io.log(`✗ ${label}: couldn’t read ${entry.file}, left unchanged`);
    }
  }

  if (!removed && !failed) io.log('Nothing to remove.');

  if (await readKey(io.keyFile)) {
    io.log(`The pairing is still active: ${io.keyFile} keeps its key.`);
  }

  return failed ? 1 : 0;
}

const STATES = {
  absent: 'not set up',
  owned: 'set up',
  other: `has its own "${SERVER}" entry`,
  invalid: 'config unreadable',
} as const;

async function status(io: CommandIO) {
  for (const agent of agentLocations(io.environment)) {
    const state = readEntry(agent.entry);
    const text = state === 'absent' && !agent.installed ? 'not installed' : STATES[state];

    io.log(`${agent.label}: ${text} (${agent.entry.file})`);
  }

  const key = await readKey(io.keyFile);

  io.log(`Pairing key: ${key ? 'present' : 'none'} (${io.keyFile})`);

  return 0;
}

/** Runs a subcommand and returns its exit code. */
export async function runCommand(name: CommandName, args: readonly string[], io: CommandIO) {
  try {
    if (name === 'status') return await status(io);

    return name === 'install' ? await install(args, io) : await uninstall(args, io);
  } catch (error) {
    io.log(error instanceof Error ? error.message : String(error));

    return 1;
  }
}

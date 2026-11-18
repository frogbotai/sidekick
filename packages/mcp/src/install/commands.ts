import { readKey, removeKey, writeKey } from '../key.js';
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
import type { Pairing } from './pair.js';
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
  pairing: Pairing;
}

const INSTALL = `${COMMAND.join(' ')} install`;

function edit(agent: AgentLocation, remove: boolean): EditResult | Error {
  try {
    return editConfig(agent.entry, remove);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function unreadable(result: EditResult['result'], file: string) {
  return result === 'invalid'
    ? `couldn’t read ${file}, left unchanged`
    : `couldn’t edit ${file} safely, left unchanged`;
}

async function choose(args: readonly string[], agents: AgentLocation[], io: CommandIO) {
  const plan = agentPlan(agents, agentFlags(args), io.tty, callingAgent(io.environment.env));

  if (!plan.picker) return plan.selected;

  return io.pick(agents, plan.selected);
}

const PENDING = `Pairing is pending: run \`${INSTALL}\` again to pair with Sidekick in Chrome.`;

async function pairAgents(agents: readonly string[], io: CommandIO) {
  if (await readKey(io.keyFile)) {
    io.log('Sidekick is paired on this computer.');

    return;
  }

  const outcome = await io.pairing.pair(agents, io.log);

  if ('key' in outcome) {
    await writeKey(outcome.key, io.keyFile);
    io.log(`✓ Paired with Sidekick in Chrome, as ${outcome.key.computer}. Key: ${io.keyFile}`);

    return;
  }

  io.log(
    outcome.pending === 'chrome'
      ? `Couldn’t open Chrome. ${PENDING}`
      : `The request wasn’t approved in time. ${PENDING}`,
  );
}

async function unpairAgents(io: CommandIO) {
  const key = await readKey(io.keyFile);

  if (!key) return;

  const remaining = agentLocations(io.environment).filter(
    (agent) => readEntry(agent.entry) === 'owned',
  );

  if (remaining.length) {
    io.log(
      `The pairing stays for ${remaining.map(({ label }) => label).join(', ')}: ${io.keyFile}`,
    );

    return;
  }

  if (await io.pairing.unpair(key, io.log)) {
    await removeKey(io.keyFile);
    io.log('✓ Revoked the pairing in Sidekick and removed its key.');

    return;
  }

  io.log(
    `Couldn’t reach Sidekick, so the pairing is still active: ${io.keyFile} keeps its key. Revoke it in Sidekick’s settings, under Connected agents.`,
  );
}

async function install(args: readonly string[], io: CommandIO) {
  const agents = agentLocations(io.environment);
  const selected = await choose(args, agents, io);

  if (selected === undefined) {
    io.log('Cancelled. Nothing was written.');

    return 1;
  }

  if (!selected.length) {
    io.log(
      'No agent was named or picked, and none is running this command, so nothing was written.',
    );

    io.log(`Name the agents: ${INSTALL} -a ${AGENT_NAMES.join(' ')}`);

    return 0;
  }

  let failed = false;
  const added: string[] = [];
  const ready: string[] = [];

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
      ready.push(label);
      io.log(`✓ ${label}: added ${SERVER} to ${entry.file}`);

      if (outcome.backup) io.log(`  Backup of the original: ${outcome.backup}`);
    } else if (outcome.result === 'unchanged') {
      ready.push(label);
      io.log(`✓ ${label}: already set up in ${entry.file}`);
    } else if (outcome.result === 'conflict') {
      io.log(`! ${label}: ${entry.file} already has its own "${SERVER}" entry, left as is`);
    } else {
      failed = true;
      io.log(`✗ ${label}: ${unreadable(outcome.result, entry.file)}`);
    }
  }

  if (!added.length && !failed) io.log('Nothing to change.');

  if (added.length) io.log(`Restart ${added.join(', ')} to load Sidekick.`);

  if (ready.length) await pairAgents(ready, io);

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
    } else if (outcome.result === 'invalid' || outcome.result === 'refused') {
      failed = true;
      io.log(`✗ ${label}: ${unreadable(outcome.result, entry.file)}`);
    }
  }

  if (!removed && !failed) io.log('Nothing to remove.');

  if (failed) {
    if (await readKey(io.keyFile)) {
      io.log(`The pairing stays until uninstall succeeds: ${io.keyFile}`);
    }
  } else {
    await unpairAgents(io);
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

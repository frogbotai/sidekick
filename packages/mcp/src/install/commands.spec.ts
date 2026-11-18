import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { writeKey } from '../key.js';
import { AGENT_NAMES, agentLocations, type AgentName, type Environment } from './agents.js';
import { BACKUP_SUFFIX } from './browse/edit.js';
import { type CommandIO, type CommandName, runCommand } from './commands.js';
import type { PairOutcome } from './pair.js';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function computer(env: NodeJS.ProcessEnv = {}, binaries: string[] = []) {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'sidekick-install-'));

  folders.push(home);

  const environment: Environment = {
    home,
    env,
    platform: 'linux',
    onPath: (binary) => binaries.includes(binary),
  };

  const lines: string[] = [];
  const picks: AgentName[][] = [];
  const pairing = {
    outcome: { pending: 'chrome' } as PairOutcome,
    revokes: true,
    asked: [] as (readonly string[])[],
    unpaired: [] as string[],
  };

  const io = (tty = false, choice?: AgentName[]): CommandIO => ({
    environment,
    keyFile: path.join(home, '.config', 'sidekick', 'pairing.json'),
    tty,
    log: (line) => void lines.push(line),
    pick: (_agents, initial) => {
      picks.push(initial);

      return Promise.resolve(choice);
    },
    pairing: {
      pair: (agents) => {
        pairing.asked.push(agents);

        return Promise.resolve(pairing.outcome);
      },
      unpair: ({ key }) => {
        pairing.unpaired.push(key);

        return Promise.resolve(pairing.revokes);
      },
    },
  });

  const run = async (name: CommandName, args: string[] = [], tty = false, choice?: AgentName[]) => {
    lines.length = 0;

    const code = await runCommand(name, args, io(tty, choice));

    return { code, output: lines.join('\n') };
  };

  const location = (name: AgentName) => {
    const found = agentLocations(environment).find((agent) => agent.name === name);

    if (!found) throw new Error(name);

    return found;
  };

  const write = (name: AgentName, text: string) => {
    const { file } = location(name).entry;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);

    return file;
  };

  return { home, run, location, write, picks, pairing, keyFile: io().keyFile };
}

const FIXTURES: Record<AgentName, string> = {
  opencode:
    '{\n  // my config\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "other": { "type": "remote", "url": "https://other" }\n  }\n}\n',
  'claude-code':
    '{\n  "numStartups": 4,\n  "mcpServers": {\n    "other": {\n      "type": "stdio",\n      "command": "other"\n    }\n  }\n}\n',
  codex: '# my config\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n',
  cursor: '{\n  // mine\n  "mcpServers": {\n    "other": { "url": "https://other" }\n  }\n}\n',
};

const ENTRIES: Record<AgentName, unknown> = {
  opencode: { type: 'local', command: ['npx', '-y', '@frogbotai/sidekick-mcp'] },
  'claude-code': { type: 'stdio', command: 'npx', args: ['-y', '@frogbotai/sidekick-mcp'] },
  codex: { command: 'npx', args: ['-y', '@frogbotai/sidekick-mcp'] },
  cursor: { command: 'npx', args: ['-y', '@frogbotai/sidekick-mcp'] },
};

function entryIn(name: AgentName, text: string) {
  if (name === 'codex') {
    return (parseToml(text) as { mcp_servers: Record<string, unknown> }).mcp_servers.sidekick;
  }

  const config = parse(text) as Record<string, Record<string, unknown>>;

  return (name === 'opencode' ? config.mcp : config.mcpServers)?.sidekick;
}

describe.each(AGENT_NAMES)('%s', (name) => {
  it('installs, says so on a rerun, and uninstalls back to the original bytes', async () => {
    const { run, write, location } = computer();
    const file = write(name, FIXTURES[name]);
    const before = fs.readFileSync(file, 'utf8');
    const label = location(name).label;

    const first = await run('install', ['-a', name]);

    expect(first.code).toBe(0);
    expect(first.output).toContain(`✓ ${label}: added sidekick to ${file}`);
    expect(first.output).toContain(`Backup of the original: ${file}${BACKUP_SUFFIX}`);
    expect(first.output).toContain('Pairing is pending');

    const after = fs.readFileSync(file, 'utf8');

    expect(entryIn(name, after)).toEqual(ENTRIES[name]);
    expect(after).not.toContain('env');
    expect(fs.readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8')).toBe(before);

    for (const line of before.split('\n')) expect(after).toContain(line);

    const second = await run('install', ['-a', name]);

    expect(second.output).toContain('Nothing to change.');
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
    expect((await run('status')).output).toContain(`${label}: set up (${file})`);

    const removed = await run('uninstall', ['-a', name]);

    expect(removed.code).toBe(0);
    expect(removed.output).toContain(`✓ ${label}: removed sidekick from ${file}`);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps an entry someone edited, and a file it can’t read', async () => {
    const { run, write } = computer();
    const file = write(name, FIXTURES[name]);

    await run('install', ['-a', name]);

    const edited = fs
      .readFileSync(file, 'utf8')
      .replace('@frogbotai/sidekick-mcp', '@frogbotai/sidekick-mcp@0.2.0');

    fs.writeFileSync(file, edited);

    expect((await run('install', ['-a', name])).output).toContain(
      'already has its own "sidekick" entry',
    );

    expect((await run('uninstall', ['-a', name])).output).toContain('isn’t one install wrote');
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);

    const broken = name === 'codex' ? '[[mcp_servers' : '{ "mcp": ';

    fs.writeFileSync(file, broken);

    const result = await run('install', ['-a', name]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`couldn’t read ${file}, left unchanged`);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });
});

describe('install', () => {
  it('writes only the agent running it, and continues past a file it can’t read', async () => {
    const claude = computer({ CLAUDECODE: '1' }, ['codex', 'cursor']);
    const { code } = await claude.run('install');

    expect(code).toBe(0);
    expect(fs.existsSync(claude.location('claude-code').entry.file)).toBe(true);
    expect(fs.existsSync(claude.location('codex').entry.file)).toBe(false);
    expect(fs.existsSync(claude.location('cursor').entry.file)).toBe(false);

    const both = computer();

    both.write('cursor', '{ broken');

    const result = await both.run('install', ['-a', 'cursor', 'codex']);

    expect(result.code).toBe(1);
    expect(result.output).toContain('✓ Codex: added sidekick');
    expect(result.output).toContain('✗ Cursor: couldn’t read');
  });

  it('asks in a terminal, and writes nothing without one, on cancel, or with -y and no caller', async () => {
    const machine = computer({}, ['opencode', 'codex']);

    const picked = await machine.run('install', [], true, ['codex']);

    expect(machine.picks).toEqual([['opencode', 'codex']]);
    expect(picked.output).toContain('✓ Codex: added');
    expect(picked.output).not.toContain('OpenCode');

    const cancelled = await machine.run('install', [], true, undefined);

    expect(cancelled).toEqual({ code: 1, output: 'Cancelled. Nothing was written.' });

    const headless = await machine.run('install');

    expect(headless.code).toBe(0);
    expect(headless.output).toContain('nothing was written');
    expect(headless.output).toContain('install -a opencode claude-code codex cursor');
    expect(fs.existsSync(machine.location('opencode').entry.file)).toBe(false);

    const yes = await machine.run('install', ['-y']);

    expect(yes.output).toContain('nothing was written');
    expect(fs.existsSync(machine.location('opencode').entry.file)).toBe(false);
  });

  it('keeps the Settings command’s own entry, with its token', async () => {
    const { run, write } = computer({ CLAUDECODE: '1' });
    const settings =
      '{\n  "mcpServers": {\n    "sidekick": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "@frogbotai/sidekick-mcp"],\n      "env": { "SIDEKICK_TOKEN": "sk_x" }\n    }\n  }\n}\n';

    const file = write('claude-code', settings);
    const result = await run('install');

    expect(result.code).toBe(0);
    expect(result.output).toContain('already has its own "sidekick" entry, left as is');
    expect(fs.readFileSync(file, 'utf8')).toBe(settings);
  });

  it('rejects an unknown agent name', async () => {
    const { run } = computer();

    expect(await run('install', ['-a', 'emacs'])).toEqual({
      code: 1,
      output: 'Unknown agent "emacs". Choose opencode, claude-code, codex, cursor.',
    });
  });
});

describe('status', () => {
  it('reports each agent and the key, and writes nothing', async () => {
    const machine = computer({}, ['cursor']);

    machine.write('codex', '[[broken');

    const before = (await machine.run('status')).output;

    expect(before).toContain(
      `OpenCode: not installed (${machine.location('opencode').entry.file})`,
    );

    expect(before).toContain('Cursor: not set up');
    expect(before).toContain('Codex: config unreadable');
    expect(before).toContain(`Pairing key: none (${machine.keyFile})`);
    expect(fs.existsSync(machine.location('cursor').entry.file)).toBe(false);

    await writeKey({ key: 'sk_k', pairingID: 'p1', computer: 'laptop' }, machine.keyFile);

    const paired = await machine.run('status');

    expect(paired.output).toContain('Pairing key: present');

    expect((await machine.run('install', ['-a', 'cursor'])).output).toContain(
      'Sidekick is paired on this computer.',
    );

    expect((await machine.run('uninstall')).output).toContain(
      `The pairing stays until uninstall succeeds: ${machine.keyFile}`,
    );

    expect(machine.pairing.unpaired).toEqual([]);
  });
});

describe('pairing', () => {
  const KEY = { key: 'sk_new', pairingID: 'p1', computer: 'laptop' };

  it('asks Sidekick for the agents it set up and keeps the key readable only by this user', async () => {
    const machine = computer();

    machine.pairing.outcome = { key: KEY };

    const { code, output } = await machine.run('install', ['-a', 'cursor', 'codex']);

    expect(code).toBe(0);
    expect(machine.pairing.asked).toEqual([['Codex', 'Cursor']]);

    expect(output).toContain(
      `✓ Paired with Sidekick in Chrome, as laptop. Key: ${machine.keyFile}`,
    );

    expect(JSON.parse(fs.readFileSync(machine.keyFile, 'utf8'))).toEqual(KEY);
    expect(fs.statSync(machine.keyFile).mode & 0o777).toBe(0o600);

    await machine.run('install', ['-a', 'cursor']);

    expect(machine.pairing.asked).toHaveLength(1);
  });

  it('pairs nothing when no agent was set up', async () => {
    const machine = computer();

    machine.write('cursor', '{ broken');

    expect((await machine.run('install', ['-a', 'cursor'])).code).toBe(1);
    expect(machine.pairing.asked).toEqual([]);
  });

  it('exits 0 with the configs written when Chrome can’t open, or the request expires', async () => {
    const machine = computer();
    const chrome = await machine.run('install', ['-a', 'cursor']);

    expect(chrome.code).toBe(0);
    expect(chrome.output).toContain('Couldn’t open Chrome. Pairing is pending');
    expect(fs.existsSync(machine.location('cursor').entry.file)).toBe(true);

    machine.pairing.outcome = { pending: 'expired' };

    const expired = await machine.run('install', ['-a', 'cursor']);

    expect(expired.code).toBe(0);
    expect(expired.output).toContain('wasn’t approved in time. Pairing is pending');
    expect(fs.existsSync(machine.keyFile)).toBe(false);
  });

  it('revokes on uninstall only once no agent uses the key, and keeps it when Sidekick can’t be reached', async () => {
    const machine = computer();

    machine.pairing.outcome = { key: KEY };
    await machine.run('install', ['-a', 'cursor', 'codex']);

    const partial = await machine.run('uninstall', ['-a', 'cursor']);

    expect(partial.output).toContain(`The pairing stays for Codex: ${machine.keyFile}`);
    expect(machine.pairing.unpaired).toEqual([]);

    machine.pairing.revokes = false;

    const unreachable = await machine.run('uninstall');

    expect(unreachable.code).toBe(0);
    expect(unreachable.output).toContain('Couldn’t reach Sidekick, so the pairing is still active');
    expect(fs.existsSync(machine.keyFile)).toBe(true);

    machine.pairing.revokes = true;

    const revoked = await machine.run('uninstall');

    expect(machine.pairing.unpaired).toEqual(['sk_new', 'sk_new']);
    expect(revoked.output).toContain('✓ Revoked the pairing in Sidekick and removed its key.');
    expect(fs.existsSync(machine.keyFile)).toBe(false);
  });
});

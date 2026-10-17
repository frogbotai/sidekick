import {
  addPairing,
  MCP_CLIENTS,
  type McpClientKind,
  mcpHubs,
  mcpPairings,
  renewPairing,
  revokePairing,
} from '@frogbotai/sidekick-core';
import { Button, Input, Label, RadioGroup, RadioGroupItem } from '@frogbotai/ui';
import { type FormEvent, useId, useState } from 'react';

import { useStored } from '../../providers/useStored';
import { commandFor, MCP_CLIENT_NAMES } from './commands';

interface Shown {
  pairingID: string;
  name: string;
  command: string;
}

function isClient(value: string): value is McpClientKind {
  return MCP_CLIENTS.some((client) => client === value);
}

/** Pairs a new agent app and returns the command to run in it, which carries the new token. */
export async function addAgent(client: McpClientKind, name: string): Promise<Shown> {
  const { pairing, token } = await addPairing({
    client,
    name: client === 'other' ? name : MCP_CLIENT_NAMES[client],
  });

  return { pairingID: pairing.id, name: pairing.name, command: commandFor(client, token) };
}

/** Replaces a pairing's token, so the old command stops working, and returns the new command. */
export async function newCommand(pairingID: string): Promise<Shown | undefined> {
  const pairing = (await mcpPairings.get()).find((entry) => entry.id === pairingID);
  const token = pairing && (await renewPairing(pairingID));

  return pairing && token
    ? { pairingID, name: pairing.name, command: commandFor(pairing.client, token) }
    : undefined;
}

/** Copies a command; resolves once the clipboard has it. */
export function copyCommand(
  command: string,
  clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard,
) {
  return clipboard.writeText(command);
}

/** The options page's Connected agents, at `#agents`: pairings, their state, and the commands. */
export function ConnectedAgents({ disconnect }: { disconnect: (pairingID: string) => void }) {
  const id = useId();
  const pairings = useStored(mcpPairings) ?? [];
  const hubs = useStored(mcpHubs) ?? [];
  const [client, setClient] = useState<McpClientKind>('claude-code');
  const [name, setName] = useState('');
  const [shown, setShown] = useState<Shown>();
  const [copied, setCopied] = useState(false);

  const show = (next: Shown | undefined) => {
    setCopied(false);
    setShown(next);
  };

  const add = (event: FormEvent) => {
    event.preventDefault();

    if (client === 'other' && !name.trim()) return;

    void addAgent(client, name.trim()).then(show);
    setName('');
  };

  const copy = (command: string) => {
    void copyCommand(command).then(() => setCopied(true));
  };

  return (
    <section id="agents" className="sidekick-stack" aria-labelledby="agents-title">
      <h2 id="agents-title">Connected agents</h2>
      <p>
        Agent apps on this computer can use Sidekick’s browser tools. They act without asking in
        Sidekick; blocked sites still apply.
      </p>
      {shown ? (
        <div className="sidekick-stack" role="status">
          <p>
            Run this in a terminal to add Sidekick to <strong>{shown.name}</strong>. It’s shown only
            once.
          </p>
          <pre className="sidekick-command" aria-label={`Command for ${shown.name}`}>
            {shown.command}
          </pre>
          <div className="sidekick-row">
            <Button onClick={() => copy(shown.command)}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button variant="ghost" onClick={() => show(undefined)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
      <ul className="sidekick-list" aria-label="Connected agents" hidden={pairings.length === 0}>
        {pairings.map((pairing) => {
          const live = hubs.some((hub) => hub.pairingID === pairing.id);

          return (
            <li key={pairing.id} className="sidekick-grant">
              <span className="sidekick-grant__text">
                <strong>{pairing.name}</strong>
                <small>{live ? 'Connected' : 'Not connected'}</small>
              </span>
              <span className="sidekick-row">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!live}
                  aria-label={`Disconnect ${pairing.name}`}
                  onClick={() => disconnect(pairing.id)}
                >
                  Disconnect
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`New command for ${pairing.name}`}
                  onClick={() => void newCommand(pairing.id).then(show)}
                >
                  New command
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Revoke ${pairing.name}`}
                  onClick={() => {
                    if (shown?.pairingID === pairing.id) show(undefined);

                    void revokePairing(pairing.id);
                  }}
                >
                  Revoke
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <form className="sidekick-stack" onSubmit={add} aria-label="Add an agent">
        <RadioGroup
          value={client}
          onValueChange={(value) => {
            if (isClient(value)) setClient(value);
          }}
        >
          {MCP_CLIENTS.map((option) => (
            <div key={option} className="sidekick-row">
              <RadioGroupItem id={`${id}-${option}`} value={option} />
              <Label htmlFor={`${id}-${option}`}>{MCP_CLIENT_NAMES[option]}</Label>
            </div>
          ))}
        </RadioGroup>
        {client === 'other' ? (
          <Input
            aria-label="Agent name"
            placeholder="My agent"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        ) : null}
        <div className="sidekick-row">
          <Button type="submit" variant="secondary" disabled={client === 'other' && !name.trim()}>
            Add
          </Button>
        </div>
      </form>
    </section>
  );
}

import {
  type AgentInfo,
  agentModels,
  agentPrompts,
  providers,
  TITLE_AGENT,
} from '@frogbotai/sidekick-core';
import { modelKey } from '@frogbotai/sidekick-core/provider';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@frogbotai/ui';
import { useId, useState } from 'react';

import type { Models } from '../providers/useModels';
import { useStored } from '../providers/useStored';
import { useAgents } from './useAgents';

const CHAT_MODEL = 'chat';

async function savePrompt(id: string, system: string | undefined) {
  const { [id]: _replaced, ...rest } = await agentPrompts.get();

  await agentPrompts.set(system === undefined ? rest : { ...rest, [id]: system });
}

async function saveModel(id: string, model: string | undefined) {
  const { [id]: _replaced, ...rest } = await agentModels.get();

  await agentModels.set(model === undefined ? rest : { ...rest, [id]: model });
}

/** Whether an agent's own model is used: subagents' and the title's; a primary agent runs on the chat's. */
export function picksModel(agent: Pick<AgentInfo, 'id' | 'mode'>) {
  return agent.mode !== 'primary' || agent.id === TITLE_AGENT;
}

function ModelSelect({ agent, models }: { agent: AgentInfo; models: Models }) {
  const id = useId();
  const listed = models.available.map((model) => ({
    key: modelKey(model),
    label: `${model.name} (${providers.get(model.providerID)?.name ?? model.providerID})`,
  }));

  const current = agent.model;
  const known = current === undefined || listed.some(({ key }) => key === current);

  return (
    <div className="sidekick-row">
      <Label htmlFor={id}>Model</Label>
      <Select
        value={current ?? CHAT_MODEL}
        onValueChange={(value) =>
          void saveModel(agent.id, value === CHAT_MODEL ? undefined : value)
        }
      >
        <SelectTrigger id={id} aria-label={`${agent.name} model`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CHAT_MODEL}>The chat’s model</SelectItem>
          {known ? null : <SelectItem value={current}>{current} (not connected)</SelectItem>}
          {listed.map(({ key, label }) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AgentCard({
  agent,
  overridden,
  models,
}: {
  agent: AgentInfo;
  overridden: boolean;
  models: Models;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const system = agent.system ?? '';

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id} className="sidekick-row">
          {agent.name}
          <code>{agent.id}</code>
        </CardTitle>
        <div className="sidekick-row">
          <Badge variant="outline">{agent.mode}</Badge>
          {agent.hidden ? <Badge variant="outline">hidden</Badge> : null}
          {overridden ? <Badge variant="accent">edited</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="sidekick-stack">
        {agent.description ? <p>{agent.description}</p> : null}
        {picksModel(agent) ? (
          <ModelSelect agent={agent} models={models} />
        ) : (
          <small>Model: {agent.model ?? 'the chat’s model'}</small>
        )}
        <h4>Rules</h4>
        {agent.permissions.length === 0 ? (
          <p>None: the chat’s mode decides.</p>
        ) : (
          <ul className="sidekick-list" aria-label={`${agent.name} rules`}>
            {agent.permissions.map((rule, index) => (
              <li key={index}>
                <code>
                  {rule.effect} {rule.action} {rule.resource}
                </code>
              </li>
            ))}
          </ul>
        )}
        {draft === undefined ? (
          <>
            <h4>System prompt</h4>
            <pre className="sidekick-command sidekick-prompt" aria-label={`${agent.name} prompt`}>
              {system}
            </pre>
            <div className="sidekick-row">
              <Button size="sm" variant="outline" onClick={() => setDraft(system)}>
                Edit
              </Button>
              {overridden ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void savePrompt(agent.id, undefined)}
                >
                  Reset to default
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <form
            className="sidekick-stack"
            onSubmit={(event) => {
              event.preventDefault();

              if (!draft.trim()) return;

              void savePrompt(agent.id, draft).then(() => setDraft(undefined));
            }}
          >
            <Label htmlFor={`${id}-prompt`}>System prompt</Label>
            <Textarea
              id={`${id}-prompt`}
              rows={12}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="sidekick-row">
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Every agent, hidden ones included, with its rules and full system prompt; prompts can be
 * replaced, and subagents and the title agent can run on their own model.
 */
export function AgentsScreen({ models }: { models: Models }) {
  const list = useAgents();
  const prompts = useStored(agentPrompts) ?? {};

  return (
    <div className="sidekick-stack">
      <h2>Agents</h2>
      <p>An edited prompt replaces the built-in one until you reset it.</p>
      {list.map((agent) => (
        <AgentCard key={agent.id} agent={agent} overridden={agent.id in prompts} models={models} />
      ))}
    </div>
  );
}

import { agents, type SessionEngine } from '@frogbotai/sidekick-core';
import type { ToolRendererProps } from '@frogbotai/ui/chat';
import { ToolCard, toolCardStatus } from '@frogbotai/ui/chat/tools';
import { createContext, type KeyboardEvent, use, useEffect, useState } from 'react';

import { childOf, stepLabel, subagentInput } from './subagent';

export interface SubagentLinks {
  engine: Pick<SessionEngine, 'messages' | 'watch'>;
  /** Shows a child session, read-only, over the chat. */
  open: (sessionID: string) => void;
}

export const SubagentContext = createContext<SubagentLinks | undefined>(undefined);

function useChildStep(
  engine: SubagentLinks['engine'] | undefined,
  child: string | undefined,
  running: boolean,
) {
  const [label, setLabel] = useState<string>();

  useEffect(() => {
    if (!engine || !child || !running) return undefined;

    let live = true;

    const refresh = () => {
      void engine.messages(child).then((messages) => {
        if (live) setLabel(stepLabel(messages));
      });
    };

    const unwatch = engine.watch((event) => {
      if (event.sessionID === child && 'seq' in event) refresh();
    });

    refresh();

    return () => {
      live = false;
      unwatch();
    };
  }, [engine, child, running]);

  return running ? (label ?? 'Starting') : undefined;
}

/** The `subagent` card's title, after v2's: the agent's name and the call's description. */
export function subagentTitle(input: unknown) {
  const { agent, description } = subagentInput(input);
  const name = (agent && agents.get(agent)?.name) ?? agent ?? 'Subagent';

  return description ? `${name}: ${description}` : name;
}

/**
 * The `subagent` tool's card, after v2's: the agent and the description, with the child's latest
 * step while it runs. Clicking it opens the child session.
 */
export function SubagentCard({ part }: ToolRendererProps) {
  const links = use(SubagentContext);
  const child = childOf(part);
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const step = useChildStep(links?.engine, child, running);
  const open = child && links ? () => links.open(child) : undefined;

  return (
    <ToolCard
      data-part="subagent"
      data-state={part.state}
      icon="robot"
      status={toolCardStatus(part)}
      title={subagentTitle(part.input)}
      subtitle={
        part.state === 'output-error' ? (
          part.errorText
        ) : step ? (
          <span role="status">{step}</span>
        ) : undefined
      }
      {...(open
        ? {
            role: 'button',
            tabIndex: 0,
            className: 'sidekick-open-child',
            onClick: open,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;

              event.preventDefault();
              open();
            },
          }
        : {})}
    />
  );
}

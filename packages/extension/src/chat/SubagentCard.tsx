import { agents, type SessionEngine } from '@frogbotai/sidekick-core';
import type { ToolRendererProps } from '@frogbotai/ui/chat';
import { LoadingIcon } from '@frogbotai/ui/icons';
import { createContext, use, useEffect, useState } from 'react';

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

/**
 * The `subagent` tool's card, after v2's: the agent, the description, a spinner and the child's
 * latest step while it runs. Clicking it opens the child session.
 */
export function SubagentCard({ part }: ToolRendererProps) {
  const links = use(SubagentContext);
  const { agent, description } = subagentInput(part.input);
  const child = childOf(part);
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const step = useChildStep(links?.engine, child, running);
  const name = (agent && agents.get(agent)?.name) ?? agent ?? 'Subagent';

  return (
    <div className="sidekick-subagent" data-part="subagent" data-state={part.state}>
      <button
        type="button"
        className="sidekick-subagent__open"
        disabled={!child || !links}
        onClick={() => {
          if (child) links?.open(child);
        }}
      >
        {running ? <LoadingIcon className="sidekick-subagent__spinner" aria-hidden /> : null}
        <strong>{name}</strong>
        {description ? <span>{description}</span> : null}
      </button>
      {step ? (
        <span className="sidekick-subagent__step" role="status">
          {step}
        </span>
      ) : null}
      {part.state === 'output-error' ? (
        <span className="sidekick-subagent__error">{part.errorText}</span>
      ) : null}
    </div>
  );
}

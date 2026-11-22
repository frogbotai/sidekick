import type { HandoffAsk } from '@frogbotai/sidekick-core';
import { Button } from '@frogbotai/ui';
import { ChatDock } from '@frogbotai/ui/chat';
import { useId, useSyncExternalStore } from 'react';

import type { HandoffRequests } from './requests';

export interface HandoffCardProps {
  ask: HandoffAsk;
  onContinue: () => void;
}

/** A handoff waiting on the person, as a card in the chat's dock, beside the one on the page. */
export function HandoffCard({ ask, onContinue }: HandoffCardProps) {
  const id = useId();

  return (
    <ChatDock
      role="region"
      aria-labelledby={id}
      className="sidekick-handoff"
      header={<span id={id}>Sidekick is waiting for you</span>}
      footer={<Button onClick={onContinue}>Continue</Button>}
    >
      <p className="sidekick-handoff__message">{ask.message}</p>
      {ask.recording ? (
        <p className="sidekick-handoff__recording">Sidekick is recording your clicks and typing</p>
      ) : null}
    </ChatDock>
  );
}

/**
 * The open chat's oldest waiting handoff, else an MCP client's, which has no chat: the panel is
 * the person's way to Continue when the page's card can't be clicked.
 */
export function handoffFor(asks: readonly HandoffAsk[], sessionID: string | undefined) {
  return (
    (sessionID === undefined ? undefined : asks.find((ask) => ask.sessionID === sessionID)) ??
    asks.find((ask) => ask.sessionID === undefined)
  );
}

export function useHandoff(requests: HandoffRequests, sessionID: string | undefined) {
  return handoffFor(useSyncExternalStore(requests.subscribe, requests.list), sessionID);
}

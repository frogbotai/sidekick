import type { PermissionAction, PermissionAsk, PermissionReply } from '@frogbotai/sidekick-core';
import { Button, Input } from '@frogbotai/ui';
import { ChatDock } from '@frogbotai/ui/chat';
import { useId, useState, useSyncExternalStore } from 'react';

import type { PermissionRequests } from './requests';

const VERBS: Record<PermissionAction, string> = {
  read: 'read',
  input: 'click and type on',
  navigate: 'open',
  tabs: 'switch tabs on',
  websearch: 'search the web for',
};

/** What Deny sends: a note turns it into a rejection that only fails this call. */
export function denial(note: string): { reply: PermissionReply; message?: string } {
  const message = note.trim();

  return message ? { reply: 'reject', message } : { reply: 'reject' };
}

export interface PermissionCardProps {
  ask: PermissionAsk;
  onReply: (reply: PermissionReply, message?: string) => void;
}

/** One waiting ask, as a card in the chat's dock: Deny, Allow once and Always allow. */
export function PermissionCard({ ask, onReply }: PermissionCardProps) {
  const id = useId();
  const [note, setNote] = useState('');

  const deny = () => {
    const { reply, message } = denial(note);

    onReply(reply, message);
  };

  return (
    <ChatDock
      role="region"
      aria-labelledby={id}
      className="sidekick-permission"
      header={
        <span id={id}>
          Allow Sidekick to {VERBS[ask.action]} <strong>{ask.site}</strong>
          {ask.inside ? (
            <>
              {' '}
              inside <strong>{ask.inside}</strong>
            </>
          ) : null}
          ?
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={deny}>
            Deny
          </Button>
          <Button variant="secondary" onClick={() => onReply('once')}>
            Allow once
          </Button>
          {ask.always ? <Button onClick={() => onReply('always')}>Always allow</Button> : null}
        </>
      }
    >
      <div className="sidekick-stack">
        {ask.always ? null : <p>Sidekick asks every time on this site.</p>}
        <Input
          aria-label="Tell Sidekick what to do instead"
          placeholder="Tell Sidekick what to do instead"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && note.trim()) deny();
          }}
        />
      </div>
    </ChatDock>
  );
}

/** The open chat's oldest waiting ask. */
export function usePermissionAsk(requests: PermissionRequests, sessionID: string | undefined) {
  const asks = useSyncExternalStore(requests.subscribe, requests.list);

  return sessionID === undefined ? undefined : asks.find((ask) => ask.sessionID === sessionID);
}

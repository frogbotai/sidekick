import type { PermissionAction, PermissionAsk, PermissionReply } from '@frogbotai/sidekick-core';
import { Button, Input } from '@frogbotai/ui';
import { ChatDock } from '@frogbotai/ui/chat';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';

import type { PermissionRequests } from './requests';

const VERBS: Record<PermissionAction, string> = {
  read: 'read',
  input: 'click and type on',
  navigate: 'open',
  tabs: 'switch tabs on',
  websearch: 'search the web for',
  webfetch: 'read pages on',
  subagent: 'start the subagent',
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

/** The oldest ask from `sessionID` or one of its subagents, whose parents `parents` maps. */
export function askFor(
  asks: readonly PermissionAsk[],
  sessionID: string | undefined,
  parents: ReadonlyMap<string, string | undefined>,
) {
  if (sessionID === undefined) return undefined;

  return asks.find(
    (ask) => ask.sessionID === sessionID || parents.get(ask.sessionID) === sessionID,
  );
}

/**
 * The open chat's oldest waiting ask, its subagents' included: `parentOf` names an ask's session's
 * parent, looked up once per session.
 */
export function usePermissionAsk(
  requests: PermissionRequests,
  sessionID: string | undefined,
  parentOf?: (sessionID: string) => Promise<string | undefined>,
) {
  const asks = useSyncExternalStore(requests.subscribe, requests.list);
  const [parents, setParents] = useState<ReadonlyMap<string, string | undefined>>(new Map());

  useEffect(() => {
    if (!parentOf) return undefined;

    const unknown = [...new Set(asks.map((ask) => ask.sessionID))].filter((id) => !parents.has(id));

    if (unknown.length === 0) return undefined;

    let live = true;

    void Promise.all(
      unknown.map(async (id) => [id, await parentOf(id).catch(() => undefined)] as const),
    ).then((found) => {
      if (live) setParents((known) => new Map([...known, ...found]));
    });

    return () => {
      live = false;
    };
  }, [asks, parentOf, parents]);

  return askFor(asks, sessionID, parents);
}

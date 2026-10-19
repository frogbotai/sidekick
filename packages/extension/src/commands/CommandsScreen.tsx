import { commandNameError, type UserCommand, userCommands } from '@frogbotai/sidekick-core';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
} from '@frogbotai/ui';
import { type FormEvent, useId, useState } from 'react';

import { useStored } from '../providers/useStored';

interface Draft {
  name: string;
  description: string;
  template: string;
  model: string;
}

const EMPTY: Draft = { name: '', description: '', template: '', model: '' };

const draftOf = (command: UserCommand): Draft => ({
  name: command.name,
  description: command.description ?? '',
  template: command.template,
  model: command.model ?? '',
});

/** The stored command a draft saves as: blank optional fields are left out. */
export function commandOf(draft: Draft): UserCommand {
  const description = draft.description.trim();
  const model = draft.model.trim();

  return {
    name: draft.name.trim(),
    template: draft.template.trim(),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
  };
}

function CommandForm({
  initial,
  others,
  onSave,
  onCancel,
}: {
  initial: Draft;
  others: readonly string[];
  onSave: (command: UserCommand) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState(false);
  const nameError = commandNameError(draft.name.trim(), others);
  const templateError = draft.template.trim() ? undefined : 'Enter a template.';

  const set = (field: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));

  const save = (event: FormEvent) => {
    event.preventDefault();
    setShown(true);

    if (nameError || templateError) return;

    void onSave(commandOf(draft)).then(() => {
      setDraft(EMPTY);
      setShown(false);
    });
  };

  return (
    <form className="sidekick-stack" onSubmit={save} noValidate>
      <Label htmlFor={`${id}-name`}>Name</Label>
      <Input
        id={`${id}-name`}
        value={draft.name}
        placeholder="summarize"
        aria-invalid={shown && nameError !== undefined}
        aria-describedby={shown && nameError ? `${id}-name-error` : undefined}
        onChange={set('name')}
      />
      {shown && nameError ? (
        <p id={`${id}-name-error`} role="alert">
          {nameError}
        </p>
      ) : null}
      <Label htmlFor={`${id}-description`}>Description</Label>
      <Input
        id={`${id}-description`}
        value={draft.description}
        placeholder="Summarize a page"
        onChange={set('description')}
      />
      <Label htmlFor={`${id}-template`}>Template</Label>
      <Textarea
        id={`${id}-template`}
        rows={4}
        value={draft.template}
        placeholder="Summarize $1 in three bullet points."
        aria-invalid={shown && templateError !== undefined}
        onChange={set('template')}
      />
      <span className="sidekick-muted">
        $1, $2… take the words typed after the command, $ARGUMENTS all of them. With neither,
        they’re added at the end.
      </span>
      {shown && templateError ? <p role="alert">{templateError}</p> : null}
      <Label htmlFor={`${id}-model`}>Model</Label>
      <Input
        id={`${id}-model`}
        value={draft.model}
        placeholder="Optional, like openai/gpt-5"
        onChange={set('model')}
      />
      <div className="sidekick-row">
        <Button type="submit">{onCancel ? 'Save' : 'Add command'}</Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The user's `/` templates: add, edit and delete. */
export function CommandsScreen() {
  const list = useStored(userCommands) ?? [];
  const [editing, setEditing] = useState<string>();
  const names = list.map(({ name }) => name);

  const replace = async (name: string | undefined, next: UserCommand | undefined) => {
    const current = await userCommands.get();
    const at = current.findIndex((command) => command.name === name);
    const kept = current.filter((command) => command.name !== name);

    if (next) kept.splice(at < 0 ? kept.length : at, 0, next);

    await userCommands.set(kept);
  };

  return (
    <div className="sidekick-stack">
      <p>Type / in the chat to run one. Built-in commands are listed by /help.</p>
      {list.length === 0 ? <p>No commands yet.</p> : null}
      <ul className="sidekick-list" aria-label="Your commands" hidden={list.length === 0}>
        {list.map((command) => (
          <li key={command.name}>
            <Card role="region" aria-label={`/${command.name}`}>
              <CardHeader>
                <CardTitle>/{command.name}</CardTitle>
              </CardHeader>
              <CardContent className="sidekick-stack">
                {editing === command.name ? (
                  <CommandForm
                    initial={draftOf(command)}
                    others={names.filter((name) => name !== command.name)}
                    onSave={async (next) => {
                      await replace(command.name, next);
                      setEditing(undefined);
                    }}
                    onCancel={() => setEditing(undefined)}
                  />
                ) : (
                  <>
                    {command.description ? <p>{command.description}</p> : null}
                    <pre className="sidekick-command">{command.template}</pre>
                    {command.model ? (
                      <span className="sidekick-muted">Model: {command.model}</span>
                    ) : null}
                    <div className="sidekick-row">
                      <Button size="sm" variant="outline" onClick={() => setEditing(command.name)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete /${command.name}`}
                        onClick={() => void replace(command.name, undefined)}
                      >
                        Delete
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <h2 className="sidekick-title">Add a command</h2>
      <CommandForm initial={EMPTY} others={names} onSave={(next) => replace(undefined, next)} />
    </div>
  );
}

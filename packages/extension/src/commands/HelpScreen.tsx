import type { ComposerCommandLike } from '@frogbotai/sidekick-core';

/** The commands that can run now, in registry order, so the built-ins come first. */
export function HelpScreen({ commands }: { commands: readonly ComposerCommandLike[] }) {
  const shown = commands.filter((command) => !command.disabled);

  return (
    <div className="sidekick-stack">
      <h2>Commands</h2>
      <p>Type / in the chat to pick one, or type the name and any text after it.</p>
      <ul className="sidekick-list" aria-label="Commands">
        {shown.map((command) => (
          <li key={command.id} className="sidekick-grant__text">
            <span>
              <code>/{command.id}</code> {command.title}
            </span>
            {command.description ? <small>{command.description}</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

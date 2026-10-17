import { type AgentInfo, offersTool } from '../agent/agent';
import { BUILD_MODE, type PermissionMode } from '../permission/modes';
import { whollyDenied } from '../permission/rules';
import type { Registry } from '../registry/registry';
import type { ToolDefinition } from '../tool/tool';
import { isWebOrigin, originOf, siteOf } from '../tool/url';
import type { PromptInput } from './queue';
import { sinceCheckpoint } from './request';
import type { DurableEventBody, SessionInfo, SessionMessage } from './schema';

type Modes = Pick<Registry<PermissionMode>, 'get' | 'list'>;

/**
 * The reminder a turn in `mode` needs, after v2's Plan plugin: the mode's enter reminder unless it
 * is the last one the request still reads (a compaction checkpoint cuts older ones off), or the
 * leave reminder of the mode the chat was last reminded of.
 */
export function modeReminder(
  messages: readonly SessionMessage[],
  modes: Modes,
  mode: string,
): string | undefined {
  const reminders = modes.list().flatMap((entry) => (entry.reminder ? [entry.reminder] : []));

  const last = sinceCheckpoint(messages).findLast(
    (message) =>
      message.type === 'synthetic' &&
      reminders.some(({ enter, leave }) => message.text === enter || message.text === leave),
  );

  const text = last?.type === 'synthetic' ? last.text : undefined;
  const wanted = modes.get(mode)?.reminder;

  if (wanted) return text === wanted.enter ? undefined : wanted.enter;

  return reminders.find(({ enter }) => enter === text)?.leave;
}

/** The site of the page a message was sent from; none for a non-web page. */
export function siteOfPage(url: string) {
  return isWebOrigin(url) ? siteOf(originOf(url)) : undefined;
}

/** The tools a step offers: none whose action the agent or the chat's mode denies everywhere. */
export function offeredTools(
  tools: Pick<Registry<ToolDefinition>, 'list'>,
  modes: Modes,
  agent: AgentInfo,
  mode: string,
) {
  const rules = modes.get(mode)?.rules ?? [];

  return tools
    .list()
    .filter((tool) => offersTool(agent, tool) && !whollyDenied(rules, tool.permission));
}

/** What a prompt writes before itself: a mode switch, the mode's reminder, and a new site. */
export function promptChanges(
  session: SessionInfo,
  input: Pick<PromptInput, 'mode' | 'site'>,
  messages: readonly SessionMessage[],
  modes: Modes,
  id: () => string,
): DurableEventBody[] {
  const current = session.mode ?? BUILD_MODE;
  const mode = input.mode ?? current;
  const reminder = modeReminder(messages, modes, mode);
  const site = input.site && siteOfPage(input.site);

  return [
    ...(mode === current ? [] : [{ type: 'session.mode.selected' as const, mode }]),
    ...(reminder ? [{ type: 'session.synthetic' as const, messageID: id(), text: reminder }] : []),
    ...(site && !session.sites?.includes(site)
      ? [{ type: 'session.site.added' as const, site }]
      : []),
  ];
}

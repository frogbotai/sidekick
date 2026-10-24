import { generateText, type LanguageModel } from 'ai';

import type { AgentInfo } from '../agent/agent';
import type { ModelLimit, ProviderModel } from '../provider/definition';
import { pickTitleModel } from '../provider/small';
import type { CacheRoute } from './cache';
import type { ReasoningPolicy } from './request';
import type { SessionInfo, UserPart } from './schema';
import type { SessionStore } from './store';

/** v2's limits: a title is at most 100 characters, from at most 2,000 of the first message. */
export const TITLE_MAX_LENGTH = 100;

export const TITLE_INPUT_MAX_LENGTH = 2_000;

/** Builds models for the engine; the extension reads keys and the catalog behind it. */
export interface ModelSource {
  /** `limit` is the model's known window, which automatic compaction needs; `cache` is its cache route. */
  resolve: (ref: string) => Promise<{
    language: LanguageModel;
    reasoning: ReasoningPolicy;
    limit?: ModelLimit;
    cache?: CacheRoute;
  }>;
  /** Every connected model, for the title's small-model fallback. */
  list: () => Promise<ProviderModel[]>;
}

export function isUntitledRoot(session: SessionInfo) {
  return !session.parentID && !session.title;
}

export function titleInput(parts: readonly UserPart[]) {
  return parts
    .flatMap((part) => {
      if (part.type === 'text') return [part.text];

      if (part.type === 'data-paste') return [part.data.text];

      return part.type === 'file-reference' ? [part.filename] : [];
    })
    .join('\n')
    .slice(0, TITLE_INPUT_MAX_LENGTH);
}

function firstLine(text: string) {
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (!line) return undefined;

  return line.length <= TITLE_MAX_LENGTH ? line : `${line.slice(0, TITLE_MAX_LENGTH - 3)}...`;
}

export interface TitleInput {
  store: SessionStore;
  models: ModelSource;
  agent: AgentInfo;
  session: SessionInfo;
  text: string;
}

/**
 * Names an untitled root session from its first message, after v2's `SessionTitle.generate`, on the
 * title agent's model, else the provider's small model, else the session's. A failure leaves it untitled.
 */
export async function generateTitle({ store, models, agent, session, text }: TitleInput) {
  try {
    const available = await models.list().catch(() => []);

    const ref = pickTitleModel({
      ...(agent.model ? { agentModel: agent.model } : {}),
      sessionModel: session.model,
      models: available,
    });

    const model = await models.resolve(ref).catch(() => models.resolve(session.model));

    const result = await generateText({
      model: model.language,
      ...(agent.system ? { system: agent.system } : {}),
      messages: [{ role: 'user', content: text }],
      maxRetries: 0,
    });

    const title = firstLine(result.text);
    const current = await store.sessions.get(session.id);

    if (!title || !current || !isUntitledRoot(current)) return;

    await store.sessions.rename(session.id, title);
  } catch {}
}

/** Titles an untitled root once, after its first message, in the background. */
export async function titleFirst(
  {
    agent,
    titled,
    ...input
  }: Omit<TitleInput, 'agent' | 'text'> & {
    agent: AgentInfo | undefined;
    titled: Set<string>;
  },
  parts: readonly UserPart[],
) {
  const { store, session } = input;

  if (!agent || titled.has(session.id) || !isUntitledRoot(session)) return;

  const users = (await store.messages(session.id)).filter(({ type }) => type === 'user');

  if (users.length !== 1) return;

  titled.add(session.id);
  void generateTitle({ ...input, agent, text: titleInput(parts) });
}

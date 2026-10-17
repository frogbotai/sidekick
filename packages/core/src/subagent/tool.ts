import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { evaluate } from '../permission/rules';
import type { ProviderModel } from '../provider/definition';
import { parseModelRef } from '../provider/ref';
import { tools } from '../registry';
import type { Registry } from '../registry/registry';
import type { SessionEngine } from '../session/engine';
import type { SessionInfo, SessionMessage } from '../session/schema';
import { defineTool, type ToolContext, ToolError } from '../tool/tool';

export const SUBAGENT_TOOL = 'subagent';

/** v2's preamble for a new child's first message. */
export const SUBAGENT_PREAMBLE = 'You are a subagent spawned by another session.';

/** v2's text when a child ends without any. */
export const NO_TEXT = 'Subagent completed without a text response.';

/** Subagents can't start subagents (v2's default `subagent_depth`). */
export const SUBAGENT_DEPTH = 1;

const Input = z.object({
  agent: z
    .string()
    .describe(
      'The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.',
    ),
  description: z.string().describe('A short 3-5 word label for the task, displayed to the user'),
  prompt: z.string().describe('The task for the subagent to perform'),
  model: z
    .string()
    .optional()
    .describe(
      'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant.',
    ),
  sessionID: z
    .string()
    .optional()
    .describe(
      'Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.',
    ),
});

const Output = z.object({ sessionID: z.string(), status: z.literal('completed') });

export const SUBAGENT_DESCRIPTION = [
  'Spawns an agent in a child session to work on the specified task.',
  'The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.',
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  'It runs the subagent to completion and returns its final response.',
].join('\n');

export interface SubagentToolOptions {
  engine: Pick<SessionEngine, 'create' | 'prompt' | 'abort' | 'cancel' | 'messages' | 'sessions'>;
  agents: Pick<Registry<AgentInfo>, 'get' | 'list'>;
  /** Every connected model, which a `model` override must be one of. */
  models: { list: () => Promise<ProviderModel[]> };
}

function refused(message: string) {
  return new ToolError('invalid_target', message);
}

/** The agents `caller` may dispatch: not primary, not hidden, and not denied `subagent` by its rules. */
export function dispatchable(agents: readonly AgentInfo[], caller: Pick<AgentInfo, 'permissions'>) {
  return agents
    .filter(
      (agent) =>
        agent.mode !== 'primary' &&
        !agent.hidden &&
        evaluate(caller.permissions, SUBAGENT_TOOL, agent.id, 'allow') !== 'deny',
    )
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

function describeFor(agents: readonly AgentInfo[], caller: AgentInfo) {
  const available = dispatchable(agents, caller);

  if (available.length === 0) return SUBAGENT_DESCRIPTION;

  return [
    SUBAGENT_DESCRIPTION,
    '',
    'Available subagents:',
    ...available.map(
      (agent) =>
        `- ${agent.id}: ${agent.description ?? 'This subagent should only be called when explicitly requested.'}`,
    ),
  ].join('\n');
}

async function checkModel(input: string, models: SubagentToolOptions['models']) {
  let ref: ReturnType<typeof parseModelRef>;

  try {
    ref = parseModelRef(input);
  } catch {
    throw refused(
      `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
    );
  }

  const model = (await models.list().catch(() => [])).find(
    (candidate) => candidate.providerID === ref.providerID && candidate.id === ref.modelID,
  );

  if (!model) {
    throw refused(`Model "${ref.providerID}/${ref.modelID}" is not connected. Omit the model.`);
  }

  if (ref.variant !== undefined && !model.variants.some(({ id }) => id === ref.variant)) {
    throw refused(
      model.variants.length === 0
        ? `Model "${ref.providerID}/${ref.modelID}" has no variants. Omit the variant.`
        : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.modelID}". Available: ${model.variants.map(({ id }) => id).join(', ')}.`,
    );
  }

  return input;
}

async function depthOf(engine: SubagentToolOptions['engine'], session: SessionInfo) {
  let depth = 0;
  let current = session;

  while (current.parentID) {
    const parent = await engine.sessions.get(current.parentID);

    if (!parent) break;

    depth++;
    current = parent;
  }

  return depth;
}

/** The child's last assistant text, after v2's `SubagentCompletion.text`. */
export function finalText(messages: readonly SessionMessage[]) {
  const last = messages.findLast((message) => message.type === 'assistant');

  if (last?.type !== 'assistant') return NO_TEXT;

  return (
    last.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
      .trim() || NO_TEXT
  );
}

function outcomeOf(messages: readonly SessionMessage[]) {
  const idle = messages.findLast((message) => message.type === 'idle');
  const error = messages.findLast((message) => message.type === 'assistant')?.error;

  return {
    outcome: idle?.type === 'idle' ? idle.outcome : 'interrupted',
    ...(error ? { error: error.message } : {}),
  };
}

/**
 * `subagent({ agent, description, prompt, model?, sessionID? })`, after OpenCode v2's subagent
 * tool: it runs the agent in a child session through the engine's queue, reports the child's id as
 * progress, waits for its turn, and returns its last text. Stop on the caller stops the child.
 */
export function subagentTool({ engine, agents, models }: SubagentToolOptions) {
  const execute = async (input: z.output<typeof Input>, ctx: ToolContext) => {
    const parent = await engine.sessions.get(ctx.session.id);

    if (!parent) throw refused(`Parent session not found: ${ctx.session.id}`);

    if ((await depthOf(engine, parent)) >= SUBAGENT_DEPTH) {
      throw refused(
        `Subagent depth limit reached (${SUBAGENT_DEPTH}). Subagents can't start subagents.`,
      );
    }

    const agent = agents.get(input.agent);

    if (!agent) throw refused(`Unknown agent: ${input.agent}`);

    if (agent.mode === 'primary') throw refused(`Agent ${input.agent} cannot run as a subagent`);

    await ctx.permission.assert({ action: 'subagent', resource: agent.id });

    const sessionID = input.sessionID || undefined;
    const existing = sessionID ? await engine.sessions.get(sessionID) : undefined;

    if (sessionID && !existing) throw refused(`Subagent session not found: ${sessionID}`);

    if (existing && existing.parentID !== parent.id) {
      throw refused(`Session ${existing.id} is not a child of the current session`);
    }

    const override = input.model ? await checkModel(input.model, models) : undefined;

    const child =
      existing ??
      (await engine.create({
        parentID: parent.id,
        title: input.description,
        agent: agent.id,
        model: override ?? agent.model ?? parent.model,
      }));

    await ctx.progress?.({ sessionID: child.id });

    const switched = existing !== undefined && existing.agent !== agent.id;
    const model = existing ? (override ?? (switched ? agent.model : undefined)) : undefined;

    const admitted = await engine.prompt({
      sessionID: child.id,
      parts: [
        {
          type: 'text',
          text: existing ? input.prompt : [SUBAGENT_PREAMBLE, input.prompt].join('\n'),
        },
      ],
      ...(switched ? { agent: agent.id } : {}),
      ...(model ? { model } : {}),
    });

    const stop = () => {
      if (!engine.cancel(child.id, admitted.messageID)) engine.abort(child.id);
    };

    if (ctx.signal.aborted) stop();
    else ctx.signal.addEventListener('abort', stop, { once: true });

    try {
      await admitted.done;
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }

    const messages = await engine.messages(child.id);
    const { outcome, error } = outcomeOf(messages);

    if (outcome === 'failed') {
      throw new ToolError(
        'request_failed',
        `Subagent failed (sessionID: ${child.id}): ${error ?? 'unknown error'}`,
        { sessionID: child.id },
      );
    }

    if (outcome === 'interrupted') {
      throw new ToolError('cancelled', `Subagent cancelled (sessionID: ${child.id})`, {
        sessionID: child.id,
      });
    }

    const text = finalText(messages);

    return {
      output: { sessionID: child.id, status: 'completed' as const },
      content: [
        {
          type: 'text' as const,
          text: `<subagent sessionID="${child.id}" state="completed">\n${text}\n</subagent>`,
        },
      ],
    };
  };

  return defineTool({
    id: SUBAGENT_TOOL,
    description: SUBAGENT_DESCRIPTION,
    describe: (caller) => describeFor(agents.list(), caller),
    input: Input,
    output: Output,
    permission: 'subagent',
    execute,
  });
}

/** Registers `subagent` in `tools` under the source `subagent`. Returns the undo. */
export function registerSubagentTool(options: SubagentToolOptions) {
  const tool = subagentTool(options);

  return tools.register(SUBAGENT_TOOL, (draft) => draft.add(tool));
}

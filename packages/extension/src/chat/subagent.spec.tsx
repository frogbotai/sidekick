import type { AssistantMessage, AssistantTool } from '@frogbotai/sidekick-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { picksModel } from '../agents/AgentsScreen';
import { childOf, stepLabel, subagentInput } from './subagent';
import { SubagentCard } from './SubagentCard';

function tool(name: string, input: unknown): AssistantTool {
  return {
    type: 'tool',
    id: 'c1',
    name,
    state: { status: 'running', input },
    time: { created: 1 },
  };
}

function step(content: AssistantMessage['content']): AssistantMessage {
  return {
    id: 'msg_a',
    sessionID: 'ses_child',
    seq: 2,
    type: 'assistant',
    agent: 'research',
    model: 'openai/gpt-luna',
    content,
    time: { created: 1 },
  };
}

describe('subagent cards', () => {
  it('names the child’s latest search, page read or writing', () => {
    expect(stepLabel([])).toBe('Starting');

    expect(stepLabel([step([tool('web_search', { query: 'chrome 142 extension changes' })])])).toBe(
      'Searching: chrome 142 extension changes',
    );

    expect(
      stepLabel([step([tool('webfetch', { url: 'https://www.developer.chrome.com/docs' })])]),
    ).toBe('Reading developer.chrome.com');

    expect(stepLabel([step([tool('snapshot', {})])])).toBe('Reading the page');
    expect(stepLabel([step([{ type: 'text', id: 't', text: '# Report' }])])).toBe('Writing');
  });

  it('reads the child from toolMetadata and the label from the input', () => {
    expect(childOf({ toolMetadata: { sessionID: 'ses_child' } })).toBe('ses_child');
    expect(childOf({})).toBeUndefined();

    expect(subagentInput({ agent: 'research', description: 'Chrome 142', prompt: 'x' })).toEqual({
      agent: 'research',
      description: 'Chrome 142',
    });
  });

  it('shows the agent, the description and a spinner while it runs', () => {
    const html = renderToStaticMarkup(
      <SubagentCard
        part={{
          type: 'dynamic-tool',
          toolName: 'subagent',
          toolCallId: 'c1',
          state: 'input-available',
          input: { agent: 'research', description: 'Chrome 142 changes', prompt: 'x' },
          toolMetadata: { sessionID: 'ses_child' },
        }}
      />,
    );

    expect(html).toContain('<strong>research</strong><span>Chrome 142 changes</span>');
    expect(html).toContain('sidekick-subagent__spinner');
    expect(html).toContain('role="status">Starting</span>');
  });

  it('offers a model picker to subagents and the title agent only', () => {
    expect(picksModel({ id: 'research', mode: 'subagent' })).toBe(true);
    expect(picksModel({ id: 'title', mode: 'primary' })).toBe(true);
    expect(picksModel({ id: 'build', mode: 'primary' })).toBe(false);
    expect(picksModel({ id: 'compaction', mode: 'primary' })).toBe(false);
  });
});

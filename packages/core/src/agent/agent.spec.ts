import { afterEach, describe, expect, it } from 'vitest';

import { agents } from '../registry';
import { offersTool } from './agent';
import { BUILD_AGENT, COMPACTION_AGENT, registerBuiltinAgents, TITLE_AGENT } from './builtin';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
});

const TOOLS = [
  { id: 'snapshot', permission: 'read' },
  { id: 'web_search', permission: 'websearch' },
];

describe('built-in agents', () => {
  it('registers a primary build agent and a hidden title agent', () => {
    dispose = registerBuiltinAgents();

    expect(agents.get(BUILD_AGENT)).toMatchObject({ mode: 'primary', hidden: false });
    expect(agents.get(TITLE_AGENT)).toMatchObject({ mode: 'primary', hidden: true });
    expect(agents.get(TITLE_AGENT)?.system).toContain('You are a title generator.');
  });

  it('offers build every tool and title none', () => {
    dispose = registerBuiltinAgents();

    const build = agents.get(BUILD_AGENT);
    const title = agents.get(TITLE_AGENT);

    if (!build || !title) throw new Error('Missing a built-in agent');

    expect(TOOLS.filter((tool) => offersTool(build, tool))).toEqual(TOOLS);
    expect(TOOLS.filter((tool) => offersTool(title, tool))).toEqual([]);
  });

  it('lets a later registration replace a built-in', () => {
    dispose = registerBuiltinAgents();

    const user = agents.register('user', (draft) => {
      const build = draft.get(BUILD_AGENT);

      if (build) draft.add({ ...build, steps: 3 });
    });

    expect(agents.get(BUILD_AGENT)?.steps).toBe(3);

    user();
  });

  it('registers a hidden compaction agent that offers no tool and holds the summary prompt', () => {
    dispose = registerBuiltinAgents();

    const compaction = agents.get(COMPACTION_AGENT);

    if (!compaction) throw new Error('Missing the compaction agent');

    expect(compaction).toMatchObject({ mode: 'primary', hidden: true });
    expect(compaction.system).toContain('## Browser State');
    expect(TOOLS.filter((tool) => offersTool(compaction, tool))).toEqual([]);
  });
});

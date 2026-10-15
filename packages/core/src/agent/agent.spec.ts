import { afterEach, describe, expect, it } from 'vitest';

import { agents } from '../registry';
import { evaluate, offersTool } from './agent';
import { BUILD_AGENT, registerBuiltinAgents, TITLE_AGENT } from './builtin';

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
});

describe('evaluate', () => {
  it('lets the last matching rule win and allows by default', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'deny' as const },
      { action: 'read', resource: '*', effect: 'allow' as const },
      { action: 'read', resource: '*.bank.test', effect: 'ask' as const },
    ];

    expect(evaluate(rules, 'read')).toBe('allow');
    expect(evaluate(rules, 'read', 'www.bank.test')).toBe('ask');
    expect(evaluate(rules, 'input')).toBe('deny');
    expect(evaluate([], 'input')).toBe('allow');
    expect(offersTool({ permissions: rules }, { permission: 'input' })).toBe(false);
    expect(offersTool({ permissions: rules }, { permission: 'read' })).toBe(true);
  });
});

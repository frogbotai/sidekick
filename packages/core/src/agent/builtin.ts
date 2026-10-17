import { agents } from '../registry';
import { COMPACTION_PROMPT } from '../session/compaction-prompt';
import type { AgentInfo } from './agent';
import { BUILD_PROMPT, EXPLORE_PROMPT, RESEARCH_PROMPT, TITLE_PROMPT } from './prompts';

export const BUILD_AGENT = 'build';

export const EXPLORE_AGENT = 'explore';

export const RESEARCH_AGENT = 'research';

/** `research`'s step cap: each step costs the user, and the last one writes the report. */
export const RESEARCH_STEPS = 40;

export const TITLE_AGENT = 'title';

export const COMPACTION_AGENT = 'compaction';

/**
 * Sidekick's built-in agents: the primary `build`, the read-only `explore` and `research`
 * subagents, and the hidden `title` and `compaction`, which may use no tool.
 */
export const BUILTIN_AGENTS: readonly AgentInfo[] = [
  {
    id: BUILD_AGENT,
    name: 'Build',
    description: 'The default agent. Uses the browser tools within your permissions.',
    mode: 'primary',
    hidden: false,
    system: BUILD_PROMPT,
    permissions: [],
  },
  {
    id: EXPLORE_AGENT,
    name: 'Explore',
    description:
      'Fast agent for researching on the web: reads pages and searches, and never acts on a page. Say how thorough to be: "quick", "medium" or "very thorough".',
    mode: 'subagent',
    hidden: false,
    system: EXPLORE_PROMPT,
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'websearch', resource: '*', effect: 'allow' },
      { action: 'webfetch', resource: '*', effect: 'allow' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ],
  },
  {
    id: RESEARCH_AGENT,
    name: 'Research',
    description:
      'Deep research on the web: many searches and pages, then a long cited report. Takes minutes; use for questions that need several sources, not quick lookups.',
    mode: 'subagent',
    hidden: false,
    system: RESEARCH_PROMPT,
    steps: RESEARCH_STEPS,
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'websearch', resource: '*', effect: 'allow' },
      { action: 'webfetch', resource: '*', effect: 'allow' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ],
  },
  {
    id: TITLE_AGENT,
    name: 'Title',
    mode: 'primary',
    hidden: true,
    system: TITLE_PROMPT,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  },
  {
    id: COMPACTION_AGENT,
    name: 'Compaction',
    mode: 'primary',
    hidden: true,
    system: COMPACTION_PROMPT,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  },
];

export function registerBuiltinAgents() {
  return agents.register('builtin', (draft) => {
    for (const agent of BUILTIN_AGENTS) draft.add(agent);
  });
}

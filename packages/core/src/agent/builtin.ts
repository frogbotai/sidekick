import { agents } from '../registry';
import type { AgentInfo } from './agent';

export const BUILD_AGENT = 'build';

export const TITLE_AGENT = 'title';

/** A placeholder until 281 writes Sidekick's system prompt. */
export const BUILD_PROMPT =
  'You are Sidekick, a browser assistant. Use the tools to read and act on web pages for the user, and answer briefly.';

/** OpenCode v2's title prompt (`packages/core/src/plugin/agent.ts`). */
export const TITLE_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`;

/** Sidekick's built-in agents: the primary `build`, and the hidden `title`, which may use no tool. */
export const BUILTIN_AGENTS: readonly AgentInfo[] = [
  {
    id: BUILD_AGENT,
    name: 'Build',
    description: 'The default agent. Uses the browser tools within your permissions.',
    mode: 'primary',
    hidden: false,
    system: BUILD_PROMPT,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
  },
  {
    id: TITLE_AGENT,
    name: 'Title',
    mode: 'primary',
    hidden: true,
    system: TITLE_PROMPT,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  },
];

export function registerBuiltinAgents() {
  return agents.register('builtin', (draft) => {
    for (const agent of BUILTIN_AGENTS) draft.add(agent);
  });
}

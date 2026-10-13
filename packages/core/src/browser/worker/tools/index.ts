import type { ToolDefinition } from '../../../tool/tool';
import type { BrowserEnv } from '../env';
import { inputTools } from './input';
import { readTools } from './read';
import { tabTools } from './tabs';

export function browserTools(env: BrowserEnv): ToolDefinition[] {
  return [...tabTools(env), ...readTools(env), ...inputTools(env)];
}

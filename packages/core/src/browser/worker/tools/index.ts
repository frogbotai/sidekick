import type { ToolDefinition } from '../../../tool/tool';
import type { BrowserEnv } from '../env';
import { inputTools } from './input';
import { pageTools } from './page';
import { readTools } from './read';
import { recordTools } from './record';
import { tabTools } from './tabs';
import { webmcpTools } from './webmcp';

export function browserTools(env: BrowserEnv): ToolDefinition[] {
  return [
    ...tabTools(env),
    ...readTools(env),
    ...recordTools(env),
    ...inputTools(env),
    ...pageTools(env),
    ...webmcpTools(env),
  ];
}

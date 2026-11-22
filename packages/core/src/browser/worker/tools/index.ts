import type { ToolDefinition } from '../../../tool/tool';
import type { BrowserEnv } from '../env';
import { emulateTools } from './emulate';
import { inputTools } from './input';
import { pageTools } from './page';
import { readTools } from './read';
import { tabTools } from './tabs';
import { webmcpTools } from './webmcp';

export function browserTools(env: BrowserEnv): ToolDefinition[] {
  return [
    ...tabTools(env),
    ...readTools(env),
    ...inputTools(env),
    ...pageTools(env),
    ...emulateTools(env),
    ...webmcpTools(env),
  ];
}

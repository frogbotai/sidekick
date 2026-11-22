import type { ToolDefinition } from '../../../tool/tool';
import type { BrowserEnv } from '../env';
import { dialogTools } from './dialog';
import { inputTools } from './input';
import { readTools } from './read';
import { tabTools } from './tabs';
import { uploadTools } from './upload';
import { webmcpTools } from './webmcp';

export function browserTools(env: BrowserEnv): ToolDefinition[] {
  return [
    ...tabTools(env),
    ...readTools(env),
    ...inputTools(env),
    ...dialogTools(env),
    ...uploadTools(env),
    ...webmcpTools(env),
  ];
}

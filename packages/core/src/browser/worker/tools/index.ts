import type { ToolDefinition } from '../../../tool/tool';
import type { BrowserEnv } from '../env';
import { captureTools } from './capture';
import { inputTools } from './input';
import { readTools } from './read';
import { tabTools } from './tabs';
import { webmcpTools } from './webmcp';

export function browserTools(env: BrowserEnv): ToolDefinition[] {
  return [
    ...tabTools(env),
    ...readTools(env),
    ...inputTools(env),
    ...captureTools(env),
    ...webmcpTools(env),
  ];
}

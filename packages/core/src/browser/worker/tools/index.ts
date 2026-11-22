import type { ToolDefinition } from '../../../tool/tool';
import type { BrowserEnv } from '../env';
import { captureTools } from './capture';
import { dialogTools } from './dialog';
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
    ...dialogTools(env),
    ...captureTools(env),
    ...pageTools(env),
    ...webmcpTools(env),
  ];
}

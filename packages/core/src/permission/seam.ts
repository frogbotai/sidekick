import type { PermissionRequest } from '../tool/tool';

/** Who is asking: the call a `permission.assert` comes from. */
export interface PermissionScope {
  sessionID: string;
  messageID: string;
  callID: string;
  agent: string;
}

/** Answers every tool's `permission.assert`, in the worker for worker and panel tools alike. */
export interface PermissionSeam {
  assert: (request: PermissionRequest, scope: PermissionScope) => Promise<void>;
}

/** The placeholder seam: it allows everything until 280's rules replace it. */
export function createPermissionSeam(): PermissionSeam {
  return { assert: () => Promise.resolve() };
}

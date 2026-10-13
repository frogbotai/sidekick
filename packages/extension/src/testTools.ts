import {
  type BrowserRuntime,
  type PermissionRequest,
  type ToolContent,
  ToolError,
  tools,
} from '@frogbotai/sidekick-core';

/** A request from an e2e test or the live runner. Only e2e and live builds answer them. */
export type TestRequest =
  | { sidekickTest: 'start'; tabId: number; label: string }
  | { sidekickTest: 'stop'; runId: string }
  | { sidekickTest: 'runs' }
  | { sidekickTest: 'call'; runId: string; tool: string; input: unknown };

export interface TestError {
  code: string;
  message: string;
  detail?: unknown;
}

export type TestReply =
  { ok: unknown; content?: ToolContent[]; asserts?: PermissionRequest[] } | { error: TestError };

declare global {
  var sidekickTest: ((request: TestRequest) => Promise<TestReply>) | undefined;
}

function isRequest(message: unknown): message is TestRequest {
  return typeof message === 'object' && message !== null && 'sidekickTest' in message;
}

function failure(error: unknown): TestReply {
  if (error instanceof ToolError) {
    return { error: { code: error.code, message: error.message, detail: error.detail } };
  }

  return {
    error: { code: 'thrown', message: error instanceof Error ? error.message : String(error) },
  };
}

async function call(runId: string, id: string, input: unknown): Promise<TestReply> {
  const tool = tools.get(id);

  if (!tool) return { error: { code: 'unknown_tool', message: `No tool ${id}` } };

  const parsed = tool.input.safeParse(input);

  if (!parsed.success) return { error: { code: 'invalid_input', message: parsed.error.message } };

  const asserts: PermissionRequest[] = [];

  const result = await tool.execute(parsed.data, {
    signal: new AbortController().signal,
    run: { id: runId },
    permission: {
      assert: (request) => {
        asserts.push(request);

        return Promise.resolve();
      },
    },
  });

  return { ok: result.output, content: result.content, asserts };
}

async function answer({ env }: BrowserRuntime, request: TestRequest): Promise<TestReply> {
  try {
    switch (request.sidekickTest) {
      case 'start': {
        const run = await env.runs.start({ tabId: request.tabId, label: request.label });

        return { ok: { runId: run.id, groupId: run.groupId } };
      }

      case 'stop':
        env.runs.stop(request.runId, 'user');

        return { ok: {} };
      case 'runs':
        return { ok: env.runs.list().map(({ id, groupId }) => ({ runId: id, groupId })) };
      case 'call':
        return await call(request.runId, request.tool, request.input);
    }
  } catch (error) {
    return failure(error);
  }
}

/**
 * Lets e2e tests (through `globalThis.sidekickTest`) and the live runner's side panel (through
 * `chrome.runtime.sendMessage`) start runs and call the registered tools. Never in a store build.
 */
export function answerTestRequests(runtime: BrowserRuntime) {
  globalThis.sidekickTest = (request) => answer(runtime, request);

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const page = sender.url?.startsWith(chrome.runtime.getURL('')) ?? false;

    if (!isRequest(message) || sender.id !== chrome.runtime.id || sender.tab || !page) {
      return undefined;
    }

    void answer(runtime, message).then(sendResponse);

    return true;
  });
}

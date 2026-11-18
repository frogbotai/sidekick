import { EVAL_TAG } from '../../protocol';
import { ToolError } from '../../tool/tool';
import { messageOf, race } from './abort';
import { type Act, send } from './env';
import type { CdpEvent } from './types';

export const SCRIPT_TIMEOUT_MS = 30_000;

export const MAX_RESULT_CHARS = 20_000;

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

interface Evaluated {
  result?: RemoteObject;
  exceptionDetails?: { text: string; lineNumber: number; exception?: RemoteObject };
}

export interface ScriptResult {
  value: string;
  truncated: boolean;
}

function field<T>(value: unknown, key: string, check: (found: unknown) => found is T) {
  const found: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

  return check(found) ? found : undefined;
}

const isNumber = (value: unknown): value is number => typeof value === 'number';

const isString = (value: unknown): value is string => typeof value === 'string';

const isNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(isNumber);

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const isEvaluated = (value: unknown): value is Evaluated => isObject(value);

const SERIALIZE = `function () {
  const refused = ['Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'RegExp', 'Error', 'Window'];
  return JSON.stringify(this, function (key, value) {
    if (typeof value === 'function') throw new TypeError('sidekick:a function');
    if (typeof value === 'symbol') throw new TypeError('sidekick:a symbol');
    if (typeof value === 'bigint') throw new TypeError('sidekick:a BigInt');
    if (value === null || typeof value !== 'object') return value;
    if (typeof Node === 'function' && value instanceof Node) throw new TypeError('sidekick:a DOM node');
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    if (refused.includes(tag)) throw new TypeError('sidekick:a ' + tag);
    return value;
  });
}`;

function notJson(what: string) {
  return new ToolError(
    'script_error',
    `The script’s result isn’t JSON: it holds ${what}. Return plain data, like element.textContent or an object of strings and numbers.`,
  );
}

function thrown({ exceptionDetails }: Evaluated) {
  if (!exceptionDetails) return undefined;

  const { exception, text, lineNumber } = exceptionDetails;
  const message = exception?.description?.split('\n')[0] ?? exception?.value ?? text;

  return new ToolError('script_error', `${String(message)} (line ${lineNumber + 1})`);
}

function refusal({ exceptionDetails }: Evaluated) {
  const message = exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? '';
  const named = /sidekick:([^\n]+)/.exec(message)?.[1];

  if (named) return notJson(named);

  return notJson(
    /circular/i.test(message) ? 'an object that refers to itself' : 'something JSON can’t hold',
  );
}

function cut(json: string): ScriptResult {
  if (json.length <= MAX_RESULT_CHARS) return { value: json, truncated: false };

  return { value: json.slice(0, MAX_RESULT_CHARS), truncated: true };
}

async function serialize(act: Act, result: RemoteObject | undefined): Promise<ScriptResult> {
  if (result?.unserializableValue !== undefined) {
    throw new ToolError(
      'script_error',
      `The script returned ${result.unserializableValue}, which JSON can’t hold. Return a string or a finite number.`,
    );
  }

  const objectId = result?.objectId;

  if (objectId === undefined) return cut(JSON.stringify(result?.value ?? null));

  try {
    const sent = await send(act, 'Runtime.callFunctionOn', {
      functionDeclaration: SERIALIZE,
      objectId,
      returnByValue: true,
    });

    const serialized = isEvaluated(sent) ? sent : {};

    if (serialized.exceptionDetails) throw refusal(serialized);

    const json = serialized.result?.value;

    return cut(typeof json === 'string' ? json : 'null');
  } finally {
    await act.env.sessions
      .send(act.tabId, 'Runtime.releaseObject', { objectId })
      .catch(() => undefined);
  }
}

function dialogWatch(act: Act) {
  let stop = () => {};

  const opened = new Promise<never>((_, reject) => {
    stop = act.env.cdp.onEvent((event: CdpEvent) => {
      if (event.tabId !== act.tabId || event.method !== 'Page.javascriptDialogOpening') return;

      const type = field(event.params, 'type', isString) ?? 'alert';
      const message = field(event.params, 'message', isString) ?? '';

      void act.env.sessions
        .send(act.tabId, 'Page.handleJavaScriptDialog', { accept: false })
        .catch(() => undefined);

      reject(
        new ToolError(
          'script_error',
          `The script opened a ${type} dialog saying “${message}”. Sidekick dismissed it; change the script so it doesn’t open dialogs.`,
          { dialog: type, message },
        ),
      );
    });
  });

  opened.catch(() => undefined);

  return { opened, stop: () => stop() };
}

async function evaluate(act: Act, method: string, params: Record<string, unknown>) {
  const watch = dialogWatch(act);

  try {
    await send(act, 'Page.enable', {});

    const running = act.env.sessions.send(
      act.tabId,
      method,
      { ...params, awaitPromise: true, returnByValue: false, userGesture: true },
      act.signal,
      { timeout: SCRIPT_TIMEOUT_MS, once: true },
    );

    running.catch(() => undefined);

    const evaluated = await Promise.race([running, watch.opened]);

    return isEvaluated(evaluated) ? evaluated : {};
  } catch (error) {
    if (error instanceof ToolError && (error.code === 'timeout' || error.code === 'stopped')) {
      await act.env.sessions
        .send(act.tabId, 'Runtime.terminateExecution', {})
        .catch(() => undefined);

      if (error.code === 'stopped') throw error;

      throw new ToolError(
        'timeout',
        `The script ran for ${SCRIPT_TIMEOUT_MS / 1000} s without finishing, so Sidekick stopped it.`,
      );
    }

    if (/detached|not attached/i.test(messageOf(error))) {
      throw new ToolError(
        'script_error',
        'The debugger let go of the tab while the script ran, so its result is lost and it may have finished. Check the page before running it again.',
      );
    }

    if (/does not evaluate to a function/i.test(messageOf(error))) {
      throw new ToolError(
        'script_error',
        'With a ref, script must be a function that takes the element, like (element) => element.value.',
      );
    }

    throw error;
  } finally {
    watch.stop();
  }
}

async function tagged(act: Act, token: string) {
  await send(act, 'DOM.getDocument', { depth: 0 });

  const search = await send(act, 'DOM.performSearch', { query: `[${EVAL_TAG}="${token}"]` });
  const searchId = field(search, 'searchId', isString);
  const count = field(search, 'resultCount', isNumber) ?? 0;

  try {
    if (searchId === undefined || count === 0) return undefined;

    const results = await send(act, 'DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
    const nodeId = field(results, 'nodeIds', isNumbers)?.[0];

    if (nodeId === undefined) return undefined;

    const resolved = await send(act, 'DOM.resolveNode', { nodeId });

    return field(field(resolved, 'object', isObject), 'objectId', isString);
  } finally {
    if (searchId !== undefined) {
      await act.env.sessions
        .send(act.tabId, 'DOM.discardSearchResults', { searchId })
        .catch(() => undefined);
    }
  }
}

async function onElement(act: Act, ref: string, script: string) {
  const token = crypto.randomUUID();

  await race(act.env.page.tag(act.tabId, ref, token), act.signal);

  let objectId: string | undefined;

  try {
    objectId = await tagged(act, token);
  } finally {
    await act.env.page.tag(act.tabId, ref, null).catch(() => undefined);
  }

  if (objectId === undefined) {
    throw new ToolError(
      'invalid_target',
      `${ref} is in a frame from another site, which eval can’t reach. Run the script without a ref, or read the element with snapshot.`,
    );
  }

  try {
    return await evaluate(act, 'Runtime.callFunctionOn', {
      functionDeclaration: script,
      objectId,
      arguments: [{ objectId }],
    });
  } finally {
    await act.env.sessions
      .send(act.tabId, 'Runtime.releaseObject', { objectId })
      .catch(() => undefined);
  }
}

/** OpenCode v2's `evaluate`: the page's main world, promises awaited, JSON back, at most 30 s. */
export async function runScript(act: Act, script: string, ref?: string): Promise<ScriptResult> {
  await act.env.sessions.ensure(act.tabId, act.signal);

  const evaluated =
    ref === undefined
      ? await evaluate(act, 'Runtime.evaluate', { expression: script, replMode: true })
      : await onElement(act, ref, script);

  const error = thrown(evaluated);

  if (error) throw error;

  return serialize(act, evaluated.result);
}

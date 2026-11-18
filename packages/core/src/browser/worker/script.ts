import { EVAL_TAG } from '../../protocol';
import { ToolError } from '../../tool/tool';
import { messageOf, race } from './abort';
import { type Act, send } from './env';
import type { CdpEvent } from './types';

export const SCRIPT_TIMEOUT_MS = 30_000;

export const MAX_RESULT_CHARS = 20_000;

/** How long a script stopped by its dialog gets to wind down, while later dialogs are still dismissed. */
export const DIALOG_SETTLE_MS = 2_000;

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
  const refused = ['Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'RegExp', 'Error', 'Window', 'Symbol'];
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

interface Run {
  act: Act;
  deadline: number;
  watch: ReturnType<typeof dialogWatch>;
}

async function serialize(run: Run, result: RemoteObject | undefined): Promise<ScriptResult> {
  if (result?.unserializableValue !== undefined) {
    throw new ToolError(
      'script_error',
      `The script returned ${result.unserializableValue}, which JSON can’t hold. Return a string or a finite number.`,
    );
  }

  const objectId = result?.objectId;

  if (objectId === undefined) return cut(JSON.stringify(result?.value ?? null));

  try {
    const serialized = await timed(run, 'Runtime.callFunctionOn', {
      functionDeclaration: SERIALIZE,
      objectId,
      returnByValue: true,
    });

    if (serialized.exceptionDetails) throw refusal(serialized);

    const json = serialized.result?.value;

    return cut(typeof json === 'string' ? json : 'null');
  } finally {
    await release(run.act, objectId);
  }
}

function release(act: Act, objectId: string) {
  return act.env.sessions
    .send(act.tabId, 'Runtime.releaseObject', { objectId })
    .catch(() => undefined);
}

function terminate(act: Act) {
  return act.env.sessions.send(act.tabId, 'Runtime.terminateExecution', {}).catch(() => undefined);
}

function dialogWatch(act: Act) {
  let stop = () => {};

  const opened = new Promise<never>((_, reject) => {
    stop = act.env.cdp.onEvent((event: CdpEvent) => {
      if (event.tabId !== act.tabId || event.method !== 'Page.javascriptDialogOpening') return;

      const type = field(event.params, 'type', isString) ?? 'alert';
      const message = field(event.params, 'message', isString) ?? '';

      void terminate(act);

      void act.env.sessions
        .send(act.tabId, 'Page.handleJavaScriptDialog', { accept: false })
        .catch(() => undefined);

      reject(
        new ToolError(
          'script_error',
          `The script opened a ${type} dialog saying “${message}”. Sidekick dismissed it and stopped the script, though code just after the dialog may have run. Change the script so it doesn’t open dialogs.`,
          { dialog: type, message },
        ),
      );
    });
  });

  opened.catch(() => undefined);

  return { opened, stop: () => stop() };
}

function timedOut() {
  return new ToolError(
    'timeout',
    `The script ran for ${SCRIPT_TIMEOUT_MS / 1000} s without finishing, so Sidekick stopped it.`,
  );
}

async function settled(running: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    running.catch(() => undefined),
    new Promise((resolve) => (timer = setTimeout(resolve, Math.max(ms, 0)))),
  ]);

  clearTimeout(timer);
}

async function timed(run: Run, method: string, params: Record<string, unknown>) {
  const { act, deadline, watch } = run;
  const left = deadline - Date.now();

  if (left <= 0) {
    await terminate(act);

    throw timedOut();
  }

  const running = act.env.sessions.send(act.tabId, method, params, act.signal, {
    timeout: left,
    once: true,
  });

  running.catch(() => undefined);

  try {
    const evaluated = await Promise.race([running, watch.opened]);

    return isEvaluated(evaluated) ? evaluated : {};
  } catch (error) {
    if (error instanceof ToolError && (error.code === 'timeout' || error.code === 'stopped')) {
      await terminate(act);

      throw error.code === 'stopped' ? error : timedOut();
    }

    if (error instanceof ToolError && error.detail?.dialog !== undefined) {
      await settled(running, Math.min(deadline - Date.now(), DIALOG_SETTLE_MS));

      throw error;
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
  }
}

const RUN_OPTIONS = { awaitPromise: true, returnByValue: false, userGesture: true };

async function awaited(run: Run, evaluated: Evaluated): Promise<Evaluated> {
  const error = thrown(evaluated);

  if (error) throw error;

  const promise = evaluated.result;

  if (promise?.subtype !== 'promise' || promise.objectId === undefined) return evaluated;

  try {
    return await awaited(
      run,
      await timed(run, 'Runtime.awaitPromise', {
        promiseObjectId: promise.objectId,
        returnByValue: false,
      }),
    );
  } finally {
    await release(run.act, promise.objectId);
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

async function onElement(run: Run, ref: string, script: string) {
  const { act } = run;
  const token = crypto.randomUUID();
  let objectId: string | undefined;

  try {
    await race(act.env.page.tag(act.tabId, ref, token), act.signal);

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
    return await timed(run, 'Runtime.callFunctionOn', {
      functionDeclaration: script,
      objectId,
      arguments: [{ objectId }],
      ...RUN_OPTIONS,
    });
  } finally {
    await release(act, objectId);
  }
}

/** OpenCode v2's `evaluate`: the page's main world, promises awaited, JSON back, at most 30 s. */
export async function runScript(act: Act, script: string, ref?: string): Promise<ScriptResult> {
  await act.env.sessions.ensure(act.tabId, act.signal);
  await send(act, 'Page.enable', {});

  const run = { act, deadline: Date.now() + SCRIPT_TIMEOUT_MS, watch: dialogWatch(act) };

  try {
    const evaluated =
      ref === undefined
        ? await timed(run, 'Runtime.evaluate', {
            expression: script,
            replMode: true,
            ...RUN_OPTIONS,
          })
        : await onElement(run, ref, script);

    return await serialize(run, (await awaited(run, evaluated)).result);
  } finally {
    run.watch.stop();
  }
}

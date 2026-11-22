import * as z from 'zod/mini';
import type { $ZodType } from 'zod/v4/core';

import { defineProtocol } from './rpc/define';
import { PERMISSION_ACTIONS, TOOL_ERROR_CODES } from './tool/tool';

const frameId = z.int().check(z.nonnegative());

const tabId = z.int().check(z.nonnegative());

const point = z.object({ x: z.number(), y: z.number() });

const size = z.object({ width: z.number(), height: z.number() });

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const ref = z.string().check(z.regex(/^f\d+e\d+$/));

const doc = z.optional(z.string());

const direction = z.enum(['up', 'down', 'left', 'right']);

const toolError = z.object({
  code: z.enum(TOOL_ERROR_CODES),
  message: z.string(),
  detail: z.optional(
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  ),
});

function outcome<T extends $ZodType>(ok: T) {
  return z.union([z.object({ ok }), z.object({ error: toolError })]);
}

const byRef = z.object({ ref, doc });

const id = z.string().check(z.minLength(1));

const scope = {
  sessionID: id,
  messageID: id,
  callID: id,
  agent: id,
  mode: z.optional(id),
  sites: z.optional(z.array(z.string())),
};

const jsonSchema = z.record(z.string(), z.unknown());

const toolContent = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('file'),
    uri: z.string(),
    mime: z.string(),
    name: z.optional(z.string()),
  }),
]);

const permissionRequest = z.object({
  action: z.enum(PERMISSION_ACTIONS),
  resource: z.string(),
  frameOrigin: z.optional(z.string()),
});

const permissionAsk = z.object({
  id,
  sessionID: id,
  callID: id,
  action: z.enum(PERMISSION_ACTIONS),
  site: z.string(),
  inside: z.optional(z.string()),
  always: z.boolean(),
});

const children = z.optional(z.array(z.object({ frameId, url: z.string() })));

const key = z.optional(z.string());

const line = z.object({
  depth: z.int().check(z.nonnegative()),
  text: z.string(),
  frame: z.optional(frameId),
  redacted: z.optional(z.boolean()),
});

const scrollStart = z.object({
  token: z.string(),
  container: z.string(),
  point,
  delta: point,
});

const scrollEnd = z.object({ moved: z.number(), at_end: z.boolean() });

const recordedStep = z.object({
  kind: z.enum(['click', 'fill', 'check', 'select']),
  frameUrl: z.string(),
  role: z.string(),
  name: z.string(),
  nearby: z.string(),
  selector: z.string(),
  value: z.optional(z.string()),
  masked: z.optional(z.string()),
  redacted: z.optional(z.boolean()),
  checked: z.optional(z.boolean()),
  options: z.optional(z.array(z.string())),
});

/** One thing the person did while Sidekick recorded the tab, as the frame saw it. */
export type RecordedStep = z.infer<typeof recordedStep>;

const origins = z.array(z.string());

const pageTool = z.object({
  name: z.string(),
  title: z.optional(z.string()),
  description: z.string(),
  input_schema: z.optional(z.unknown()),
  annotations: z.optional(z.record(z.string(), z.boolean())),
  origin: z.string(),
  truncated: z.optional(z.boolean()),
});

export const sidekickProtocol = defineProtocol({
  methods: {
    'tab.ping': {
      input: z.object({ tabId, frameId }),
      output: z.object({ frameId, url: z.string(), bootId: z.string() }),
    },
    'run.start': {
      input: z.object({ tabId, label: z.string().check(z.minLength(1)) }),
      output: z.object({ runId: z.string(), groupId: z.int() }),
    },
    'run.stop': { input: z.object({ runId: z.string() }), output: z.object({}) },
    'run.end': {
      input: z.object({ sessionID: id, close: z.boolean() }),
      output: z.object({}),
    },
    'tool.list': {
      input: z.object({}),
      output: z.array(
        z.object({
          id,
          description: z.string(),
          permission: z.enum(PERMISSION_ACTIONS),
          acts: z.optional(z.boolean()),
          input: jsonSchema,
          output: jsonSchema,
        }),
      ),
    },
    'tool.call': {
      input: z.object({
        ...scope,
        tool: id,
        input: z.unknown(),
        windowId: z.optional(z.int()),
        runSessionID: z.optional(id),
      }),
      output: outcome(z.object({ output: z.unknown(), content: z.optional(z.array(toolContent)) })),
    },
    'tool.cancel': { input: z.object({ callID: id }), output: z.object({}) },
    'permission.assert': {
      input: z.object({ ...scope, request: permissionRequest }),
      output: outcome(z.null()),
    },
    'permission.reply': {
      input: z.object({
        id,
        reply: z.enum(['once', 'always', 'reject']),
        message: z.optional(z.string()),
      }),
      output: z.object({}),
    },
    'permission.list': {
      input: z.object({ sessionID: z.optional(id) }),
      output: z.array(permissionAsk),
    },
    'mcp.connect': {
      input: z.object({ hub: z.string(), token: z.string(), tabId: z.optional(tabId) }),
      output: z.union([
        z.object({ connected: z.literal(true), name: z.string(), adopted: z.boolean() }),
        z.object({
          connected: z.literal(false),
          reason: z.enum(['not_loopback', 'unknown_token', 'unreachable']),
        }),
      ]),
    },
    'mcp.disconnect': { input: z.object({ pairingID: id }), output: z.object({}) },
    'mcp.pair': {
      input: z.object({ hub: z.string(), pair: z.string(), computer: z.string() }),
      output: z.union([
        z.object({ paired: z.literal(true), name: z.string() }),
        z.object({ paired: z.literal(false), reason: z.enum(['not_loopback', 'unreachable']) }),
      ]),
    },
    'mcp.unpair': {
      input: z.object({ hub: z.string(), token: z.string() }),
      output: z.union([
        z.object({ unpaired: z.literal(true) }),
        z.object({ unpaired: z.literal(false), reason: z.enum(['not_loopback', 'unreachable']) }),
      ]),
    },
  },
  events: {
    'run.stopped': z.object({
      runId: z.string(),
      reason: z.enum(['user', 'group_closed', 'aborted']),
      sessionID: z.optional(z.string()),
    }),
    'page.stripped': z.object({ tabId, removed: z.array(z.string()) }),
    'permission.asked': permissionAsk,
    'permission.replied': z.object({ id, sessionID: id }),
    'tool.progress': z.object({ callID: id, metadata: z.record(z.string(), z.string()) }),
  },
});

/** The attribute `eval` with a ref puts on its element for a moment, so the debugger can find it. */
export const EVAL_TAG = 'data-sidekick-eval';

export const frameProtocol = defineProtocol({
  methods: {
    'frame.ping': { input: z.object({}), output: z.object({ url: z.string() }) },
    'page.snapshot': {
      input: z.object({
        frameId,
        scope: z.enum(['viewport', 'page']),
        ref: z.optional(ref),
        doc,
        max_chars: z.int().check(z.positive()),
        base: z.int().check(z.positive()),
        children,
        key,
      }),
      output: outcome(
        z.object({
          title: z.string(),
          doc: z.string(),
          lines: z.array(line),
          truncated: z.boolean(),
          next: z.int().check(z.positive()),
        }),
      ),
    },
    'page.text': {
      input: z.object({ ref: z.optional(ref), doc, max_chars: z.int().check(z.positive()) }),
      output: outcome(z.object({ title: z.string(), text: z.string(), truncated: z.boolean() })),
    },
    'page.inspect': {
      input: byRef,
      output: outcome(
        z.object({
          frameOrigin: z.string(),
          redacted: z.boolean(),
          role: z.string(),
          name: z.string(),
          max_length: z.optional(z.int().check(z.nonnegative())),
        }),
      ),
    },
    'page.scrollTo': {
      input: byRef,
      output: outcome(
        z.object({ point, rect, in_view: z.boolean(), obscured_by: z.optional(z.string()) }),
      ),
    },
    'page.frameBox': {
      input: z.object({ frameId, reveal: z.boolean(), point: z.optional(point), children, key }),
      output: outcome(z.object({ origin: point, obscured_by: z.optional(z.string()) })),
    },
    'page.focus': {
      input: z.object({ ref, doc, end: z.optional(z.boolean()) }),
      output: outcome(z.null()),
    },
    'page.selectContents': { input: byRef, output: outcome(z.null()) },
    'page.focused': {
      input: z.object({ children, key }),
      output: outcome(
        z.object({
          frameOrigin: z.string(),
          editable: z.boolean(),
          role: z.string(),
          name: z.string(),
          descend: z.optional(z.object({ frameId })),
        }),
      ),
    },
    'page.checkState': {
      input: byRef,
      output: outcome(z.object({ role: z.string(), checked: z.boolean(), disabled: z.boolean() })),
    },
    'page.selectOptions': {
      input: z.object({ ref, doc, values: z.array(z.string()) }),
      output: outcome(z.array(z.string())),
    },
    'page.scrollStart': {
      input: z.object({
        ref: z.optional(ref),
        doc,
        point: z.optional(point),
        direction,
        amount: z.optional(z.number().check(z.positive())),
        children,
        key,
      }),
      output: outcome(
        z.object({
          start: z.nullable(scrollStart),
          descend: z.optional(z.object({ frameId, point })),
        }),
      ),
    },
    'page.scrollEnd': { input: z.object({ token: z.string() }), output: outcome(scrollEnd) },
    'page.scrollFallback': { input: z.object({ token: z.string() }), output: outcome(scrollEnd) },
    'page.domQuiet': {
      input: z.object({ quiet: z.number(), cap: z.number() }),
      output: outcome(z.boolean()),
    },
    'page.viewport': { input: z.object({}), output: outcome(size) },
    'page.iframes': { input: z.object({}), output: outcome(z.array(z.string())) },
    'page.probe': {
      input: z.object({ selectors: z.array(z.string()) }),
      output: outcome(
        z.object({
          url: z.string(),
          title: z.string(),
          text: z.string(),
          textLength: z.number(),
          scriptSrcs: z.array(z.string()),
          selectors: z.array(z.string()),
          visibleSelectors: z.array(z.string()),
        }),
      ),
    },
    'page.strip': {
      input: z.object({ reported: z.array(z.string()), surplus: z.int().check(z.positive()) }),
      output: outcome(z.array(z.string())),
    },
    'page.indicator': {
      input: z.object({
        visible: z.optional(z.boolean()),
        cursor: z.optional(point),
        hidden: z.optional(z.boolean()),
      }),
      output: outcome(z.null()),
    },
    'page.stopAt': { input: z.object({ point }), output: outcome(z.boolean()) },
    'page.hasText': { input: z.object({ text: z.string() }), output: outcome(z.boolean()) },
    'page.isVisible': { input: byRef, output: outcome(z.boolean()) },
    'page.tag': {
      input: z.object({ ref, doc, token: z.nullable(z.string()) }),
      output: outcome(z.null()),
    },
    'page.record': { input: z.object({ on: z.boolean() }), output: outcome(z.null()) },
    'page.webmcpList': {
      input: z.object({ fromOrigins: origins }),
      output: outcome(z.object({ tools: z.array(pageTool), more: z.int().check(z.nonnegative()) })),
    },
    'page.webmcpCall': {
      input: z.object({
        token: id,
        name: z.string(),
        origin: z.string(),
        input: z.record(z.string(), z.unknown()),
        fromOrigins: origins,
      }),
      output: outcome(
        z.object({
          result: z.optional(z.string()),
          truncated: z.optional(z.boolean()),
          error: z.optional(z.string()),
        }),
      ),
    },
    'page.webmcpCancel': { input: z.object({ token: id }), output: outcome(z.null()) },
  },
});

/** What a content script may ask the worker: only about its own tab, which the worker reads from `sender.tab`. */
export const contentProtocol = defineProtocol({
  methods: {
    'indicator.state': { input: z.object({}), output: z.object({ visible: z.boolean() }) },
    'indicator.stop': { input: z.object({}), output: z.object({}) },
    'frame.identify': { input: z.object({}), output: z.object({ frameId, key: z.string() }) },
    'recorder.state': { input: z.object({}), output: z.object({ on: z.boolean() }) },
    'recorder.step': { input: recordedStep, output: z.object({}) },
  },
});

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
          input: jsonSchema,
          output: jsonSchema,
        }),
      ),
    },
    'tool.call': {
      input: z.object({ ...scope, tool: id, input: z.unknown(), windowId: z.optional(z.int()) }),
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
  },
});

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
        children,
        key,
      }),
      output: outcome(
        z.object({
          title: z.string(),
          doc: z.string(),
          lines: z.array(line),
          truncated: z.boolean(),
        }),
      ),
    },
    'page.inspect': {
      input: byRef,
      output: outcome(
        z.object({
          frameOrigin: z.string(),
          redacted: z.boolean(),
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
    'page.focus': { input: byRef, output: outcome(z.null()) },
    'page.selectContents': { input: byRef, output: outcome(z.null()) },
    'page.readValue': { input: byRef, output: outcome(z.string()) },
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
    'page.strip': {
      input: z.object({ reported: z.array(z.string()), surplus: z.int().check(z.positive()) }),
      output: outcome(z.array(z.string())),
    },
    'page.indicator': {
      input: z.object({ visible: z.optional(z.boolean()), cursor: z.optional(point) }),
      output: outcome(z.null()),
    },
  },
});

/** What a content script may ask the worker: only about its own tab, which the worker reads from `sender.tab`. */
export const contentProtocol = defineProtocol({
  methods: {
    'indicator.state': { input: z.object({}), output: z.object({ visible: z.boolean() }) },
    'indicator.stop': { input: z.object({}), output: z.object({}) },
    'frame.identify': { input: z.object({}), output: z.object({ frameId, key: z.string() }) },
  },
});

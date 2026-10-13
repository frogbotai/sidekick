import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { checkTool, defineTool, ToolError } from './tool';
import { normalizeUrl, originOf } from './url';

function tool(id: string, input: z.ZodType) {
  return defineTool({
    id,
    description: 'test',
    input,
    output: z.object({}),
    permission: 'read',
    execute: () => Promise.resolve({ output: {} }),
  });
}

describe('checkTool (req. 4)', () => {
  it('accepts an id of letters, digits, _ and - with an object input', () => {
    expect(checkTool(tool('tabs_list-2', z.object({ a: z.string() })))).toBeUndefined();
  });

  it.each(['', 'browser.click', 'has space', 'x'.repeat(65)])('refuses the id %j', (id) => {
    expect(checkTool(tool(id, z.object({})))?.message).toMatch(/Invalid tool id/);
  });

  it('refuses an input with no JSON Schema, or one that isn’t an object', () => {
    expect(checkTool(tool('when', z.object({ at: z.date() })))?.message).toMatch(/no JSON Schema/);
    expect(checkTool(tool('text', z.string()))?.message).toMatch(/must be an object/);
  });
});

describe('normalizeUrl', () => {
  it.each([
    ['example.com/a', 'https://example.com/a'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['  ', 'about:blank'],
    ['https://Example.com', 'https://example.com/'],
  ])('reads %j as %s', (input, url) => {
    expect(normalizeUrl(input)).toBe(url);
  });

  it.each([
    '/tmp/x',
    './a',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pw@example.com',
    'chrome://settings',
  ])('refuses %j with invalid_target', (input) => {
    expect(() => normalizeUrl(input)).toThrow(ToolError);
  });

  it('names an origin, or the URL itself when it has none', () => {
    expect(originOf('https://example.com/a?b')).toBe('https://example.com');
    expect(originOf('about:blank')).toBe('about:blank');
  });
});

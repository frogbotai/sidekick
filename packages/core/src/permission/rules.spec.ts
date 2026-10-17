import { describe, expect, it } from 'vitest';

import { siteOf } from '../tool/url';
import { BUILTIN_MODES, expandRules } from './modes';
import { evaluate, stricter, whollyDenied } from './rules';
import { coversSite, isSensitive } from './sensitive';

const mode = (id: string) => BUILTIN_MODES.find((entry) => entry.id === id)?.rules ?? [];

describe('permission rules', () => {
  it('lets the last matching rule win, and falls back when none does', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'deny' as const },
      { action: 'read', resource: '*', effect: 'allow' as const },
      { action: 'read', resource: '*.bank.test', effect: 'ask' as const },
    ];

    expect(evaluate(rules, 'read')).toBe('allow');
    expect(evaluate(rules, 'read', 'www.bank.test')).toBe('ask');
    expect(evaluate(rules, 'input')).toBe('deny');
    expect(evaluate([], 'input')).toBe('ask');
    expect(evaluate([], 'input', '*', 'allow')).toBe('allow');
  });

  it('hides only actions denied everywhere: Plan’s input, not Build’s', () => {
    expect(whollyDenied(mode('plan'), 'input')).toBe(true);
    expect(whollyDenied(mode('plan'), 'read')).toBe(false);
    expect(whollyDenied(mode('build'), 'input')).toBe(false);
  });

  it('takes the stricter effect', () => {
    expect(stricter('allow', 'ask')).toBe('ask');
    expect(stricter('deny', 'ask')).toBe('deny');
    expect(stricter('allow', 'allow')).toBe('allow');
  });

  it('expands {chat} to each chat site', () => {
    expect(expandRules(mode('build'), ['a.test', 'b.test']).slice(2)).toEqual([
      { action: 'input', resource: 'a.test', effect: 'allow' },
      { action: 'input', resource: 'b.test', effect: 'allow' },
    ]);
  });
});

describe('sites', () => {
  it('folds www., case and a trailing dot, keeps the port, and leaves other resources raw', () => {
    expect(siteOf('https://WWW.GitHub.com.')).toBe('github.com');
    expect(siteOf('https://github.com:8443')).toBe('github.com:8443');
    expect(siteOf('http://localhost:3000')).toBe('localhost:3000');
    expect(siteOf('*')).toBe('*');
    expect(siteOf('chrome mv3')).toBe('chrome mv3');
    expect(siteOf('about:blank')).toBe('about:blank');
  });

  it('covers subdomains, and a listed port only matches itself', () => {
    expect(isSensitive('js.stripe.com')).toBe(true);
    expect(isSensitive('stripe.com:443')).toBe(true);
    expect(isSensitive('notstripe.com')).toBe(false);
    expect(coversSite('shop.example:8080', 'shop.example:8080')).toBe(true);
    expect(coversSite('shop.example:8080', 'shop.example')).toBe(false);
  });
});

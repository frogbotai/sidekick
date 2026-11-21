import { describe, expect, it } from 'vitest';

import { MIN_EXTENSION, OLD_EXTENSION, olderThan, withVersions } from './status.js';

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

describe('olderThan', () => {
  it('compares each part as a number', () => {
    expect(olderThan('0.8.9', '0.9.0')).toBe(true);
    expect(olderThan('0.9.0', '0.9.0')).toBe(false);
    expect(olderThan('0.10.0', '0.9.0')).toBe(false);
    expect(olderThan('0.9', '0.9.1')).toBe(true);
    expect(olderThan('1.0.0', '0.9.0')).toBe(false);
  });
});

describe('withVersions', () => {
  it('adds the helper version and flags only an extension older than the minimum', () => {
    expect(withVersions(text({ extensionVersion: MIN_EXTENSION }), '0.1.0')).toEqual(
      text({ extensionVersion: MIN_EXTENSION, helperVersion: '0.1.0', versionMismatch: false }),
    );

    expect(withVersions(text({ extensionVersion: '0.8.0' }), '0.1.0')).toEqual(
      text({
        extensionVersion: '0.8.0',
        helperVersion: '0.1.0',
        versionMismatch: true,
        nextStep: OLD_EXTENSION,
      }),
    );
  });

  it('leaves errors and results that aren’t a JSON object alone', () => {
    const error = { isError: true, content: [{ type: 'text', text: 'denied' }] };

    expect(withVersions(error, '0.1.0')).toBe(error);
    expect(withVersions(text([1]), '0.1.0')).toEqual(text([1]));
    expect(withVersions(undefined, '0.1.0')).toBeUndefined();
  });
});

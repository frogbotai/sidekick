import { describe, expect, it } from 'vitest';

import { expandTemplate, parseArguments } from './template';

describe('expandTemplate', () => {
  const cases = [
    ...['$&', '$$', '$`', "$'"].flatMap((input) => [
      { template: 'Explain $ARGUMENTS.', input, expected: `Explain ${input}.` },
      { template: 'Explain $1.', input: `"${input}"`, expected: `Explain ${input}.` },
      { template: 'Explain.', input, expected: `Explain.\n\n${input}` },
    ]),
    ...['abc', '', 'alpha beta', '"alpha beta"', '$1', '$<name>'].map((input) => ({
      template: 'Explain $ARGUMENTS.',
      input,
      expected: `Explain ${input}.`,
    })),
    {
      template: 'First $1. Rest $2.',
      input: '"alpha beta" gamma delta',
      expected: 'First alpha beta. Rest gamma delta.',
    },
    { template: '$ARGUMENTS / $ARGUMENTS', input: '$& $$', expected: '$& $$ / $& $$' },
    { template: 'Summarize $1', input: '"the page"', expected: 'Summarize the page' },
    { template: 'Compare $1 and $2.', input: 'one', expected: 'Compare one and .' },
    { template: 'Explain.', input: '   ', expected: 'Explain.' },
  ];

  for (const { template, input, expected } of cases) {
    it(`expands ${JSON.stringify(template)} with literal input ${JSON.stringify(input)}`, () => {
      expect(expandTemplate(template, input)).toBe(expected);
    });
  }

  it('keeps an [Image N] token as one argument', () => {
    expect(parseArguments('[Image 1] "a b" \'c d\' e')).toEqual(['[Image 1]', 'a b', 'c d', 'e']);

    expect(expandTemplate('Describe $1, then $2.', '[Image 2] closely')).toBe(
      'Describe [Image 2], then closely.',
    );
  });
});

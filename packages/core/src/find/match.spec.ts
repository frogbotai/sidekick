import { describe, expect, it } from 'vitest';

import { FIND_MAX_MATCHES, outlineElements, parseMatches } from './match';

const OUTLINE = [
  '- banner',
  '  - textbox "Search" value="usb c" [f0e1]',
  '  - button "Go" [f0e2]',
  '- form "Checkout"',
  '  - text "Pay now"',
  '  - button "Submit" [f0e3]',
  '  - textbox "Card number" value=[redacted] [f0e4]',
].join('\n');

describe('outlineElements', () => {
  it('maps each ref to its element line', () => {
    expect([...outlineElements(OUTLINE)]).toEqual([
      ['f0e1', 'textbox "Search" value="usb c"'],
      ['f0e2', 'button "Go"'],
      ['f0e3', 'button "Submit"'],
      ['f0e4', 'textbox "Card number" value=[redacted]'],
    ]);
  });
});

describe('parseMatches', () => {
  it('rebuilds each match from its outline line', () => {
    expect(parseMatches('f0e3 — the only Submit button\nf0e2 - also a button', OUTLINE)).toEqual([
      'button "Submit" [f0e3] — the only Submit button',
      'button "Go" [f0e2] — also a button',
    ]);
  });

  it('drops unknown refs and duplicates', () => {
    expect(parseMatches('f9e99 — made up\nf0e3: Submit\n[f0e3] again', OUTLINE)).toEqual([
      'button "Submit" [f0e3] — Submit',
    ]);
  });

  it('returns nothing for none, even when it names a near miss', () => {
    expect(parseMatches('none', OUTLINE)).toEqual([]);
    expect(parseMatches('None. The closest is f0e2, but it is Go.', OUTLINE)).toEqual([]);
  });

  it('keeps every ref on a line', () => {
    expect(parseMatches('f0e3, f0e2', OUTLINE)).toEqual([
      'button "Submit" [f0e3]',
      'button "Go" [f0e2]',
    ]);
  });

  it('counts only the refs before the reason', () => {
    expect(parseMatches('f0e3 — better than f0e2 which is Go', OUTLINE)).toEqual([
      'button "Submit" [f0e3] — better than f0e2 which is Go',
    ]);

    expect(parseMatches('f0e3 — unlike f9e9 or [f9e8]', OUTLINE)).toEqual([
      'button "Submit" [f0e3] — unlike … or …',
    ]);

    expect(parseMatches('[f0e3] and [f0e2] — both buttons', OUTLINE)).toEqual([
      'button "Submit" [f0e3] — both buttons',
      'button "Go" [f0e2] — both buttons',
    ]);

    expect(parseMatches('- button "Submit" [f0e3] — submit', OUTLINE)).toEqual([
      'button "Submit" [f0e3] — submit',
    ]);
  });

  it('reads refs the way models format them, with a clean reason', () => {
    const replies = [
      '1. f0e3 — the Submit button',
      '- [f0e3] — the Submit button',
      '`f0e3` — the Submit button',
      '**f0e3** — the Submit button',
      'f0e3: the Submit button',
    ];

    expect(replies.map((reply) => parseMatches(reply, OUTLINE))).toEqual(
      replies.map(() => ['button "Submit" [f0e3] — the Submit button']),
    );
  });

  it('caps reasons and the number of matches', () => {
    const outline = Array.from({ length: 20 }, (_, i) => `- link "L${i}" [f0e${i}]`).join('\n');
    const reply = Array.from({ length: 20 }, (_, i) => `f0e${i} — ${'x'.repeat(300)}`).join('\n');
    const matches = parseMatches(reply, outline);

    expect(matches).toHaveLength(FIND_MAX_MATCHES);
    expect(matches[0]?.length).toBeLessThan(160);
  });
});

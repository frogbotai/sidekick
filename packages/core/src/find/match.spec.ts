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

  it('returns nothing for none', () => {
    expect(parseMatches('none', OUTLINE)).toEqual([]);
  });

  it('caps reasons and the number of matches', () => {
    const outline = Array.from({ length: 20 }, (_, i) => `- link "L${i}" [f0e${i}]`).join('\n');
    const reply = Array.from({ length: 20 }, (_, i) => `f0e${i} — ${'x'.repeat(300)}`).join('\n');
    const matches = parseMatches(reply, outline);

    expect(matches).toHaveLength(FIND_MAX_MATCHES);
    expect(matches[0]?.length).toBeLessThan(160);
  });
});

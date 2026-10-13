import { describe, expect, it } from 'vitest';

import { type FrameOutline, stitch, truncationNote } from './stitch';

function outline(lines: FrameOutline['lines'], truncated = false): FrameOutline {
  return { title: 'Top', lines, truncated };
}

describe('stitch', () => {
  it('nests each child frame under its iframe line', () => {
    const frames = new Map<number, FrameOutline | undefined>([
      [
        0,
        outline([
          { depth: 0, text: '- heading 1 "Shop"' },
          { depth: 0, text: '- iframe "Payment"', frame: 3 },
          { depth: 0, text: '- button "Buy" [f0e2]' },
        ]),
      ],
      [
        3,
        outline([{ depth: 0, text: '- textbox "Card" value=[redacted] [f3e1]', redacted: true }]),
      ],
    ]);

    expect(stitch(frames, 0, 30_000)).toEqual({
      text: [
        '- heading 1 "Shop"',
        '- iframe "Payment"',
        '  - textbox "Card" value=[redacted] [f3e1]',
        '- button "Buy" [f0e2]',
      ].join('\n'),
      redacted: 1,
      truncated: false,
    });
  });

  it('keeps a frame it couldn’t read as one line, not a failure', () => {
    const frames = new Map<number, FrameOutline | undefined>([
      [0, outline([{ depth: 1, text: '- iframe "Ads"', frame: 7 }])],
      [7, undefined],
    ]);

    expect(stitch(frames, 0, 30_000).text).toBe('  - iframe "Ads" (not readable)');
  });

  it('stops at max_chars with a note, counting only the redacted lines it kept', () => {
    const lines = Array.from({ length: 50 }, (_, index) => ({
      depth: 0,
      text: `- textbox "Field ${String(index).padStart(2, '0')}" value=[redacted] [f0e${index}]`,
      redacted: true,
    }));

    const result = stitch(new Map([[0, outline(lines)]]), 0, 1_000);
    const kept = result.text.split('\n');

    expect(result.truncated).toBe(true);
    expect(kept.at(-1)).toBe(truncationNote(1_000));
    expect(result.redacted).toBe(kept.length - 1);
    expect(kept.slice(0, -1).join('\n').length).toBeLessThanOrEqual(1_000);
  });

  it('notes a frame the content script truncated on its own', () => {
    const result = stitch(
      new Map([[0, outline([{ depth: 0, text: '- text "a"' }], true)]]),
      0,
      30_000,
    );

    expect(result.text).toBe(`- text "a"\n${truncationNote(30_000)}`);
    expect(result.truncated).toBe(true);
  });
});

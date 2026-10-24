// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import { refOf, setup, useContentDom } from './harness';

useContentDom();

const NAV = `<nav aria-label="Domains">${Array.from(
  { length: 120 },
  (_, index) => `<a href="/d/${index}">frogbot-domain-${index}.com</a>`,
).join('')}</nav>`;

const DIALOG = [
  '<div role="dialog" aria-label="Edit nameservers">',
  '<input aria-label="Nameserver 1">',
  '<input aria-label="Nameserver 2">',
  '<button>Save</button>',
  '</div>',
].join('');

describe('open dialogs come first (329 D3)', () => {
  it('lists a dialog at the end of a long body first, once, within max_chars 2,000', async () => {
    document.body.innerHTML = `${NAV}<main><h1>Portfolio</h1></main>${DIALOG}`;

    const { snapshot } = setup();
    const outline = await snapshot({ max_chars: 2_000 });
    const lines = outline.lines.map((line) => `${'  '.repeat(line.depth)}${line.text}`);

    expect(outline.truncated).toBe(true);

    expect(lines.slice(0, 4)).toEqual([
      '- dialog "Edit nameservers"',
      expect.stringMatching(/^ {2}- textbox "Nameserver 1" \[f0e\d+\]$/),
      expect.stringMatching(/^ {2}- textbox "Nameserver 2" \[f0e\d+\]$/),
      expect.stringMatching(/^ {2}- button "Save" \[f0e\d+\]$/),
    ]);

    expect(lines[4]).toBe('- navigation "Domains"');

    const whole = await snapshot();

    expect(whole.lines.filter((line) => line.text.includes('Edit nameservers'))).toHaveLength(1);
  });

  it('lists an open <dialog> and an alertdialog in a closed shadow root', async () => {
    document.body.innerHTML = `${NAV}<dialog open aria-label="Confirm"><button>OK</button></dialog><div id="host"></div>`;

    const host = document.getElementById('host');

    if (!host) throw new Error('No host');

    host.attachShadow({ mode: 'closed' }).innerHTML =
      '<div role="alertdialog" aria-label="Session expiring"><button>Stay signed in</button></div>';

    const text = await setup().text({ max_chars: 1_000 });

    expect(text.split('\n').slice(0, 4)).toEqual([
      '- dialog "Confirm"',
      expect.stringContaining('- button "OK"'),
      '- alertdialog "Session expiring"',
      expect.stringContaining('- button "Stay signed in"'),
    ]);
  });

  it('moves only the outermost dialog, and leaves hidden or closed ones out', async () => {
    document.body.innerHTML = [
      NAV,
      '<div role="dialog" aria-label="Outer"><div role="dialog" aria-label="Inner"><button>Deep</button></div></div>',
      '<div role="dialog" aria-label="Hidden" style="display: none"><button>Ghost</button></div>',
      '<dialog aria-label="Closed"><button>Shut</button></dialog>',
    ].join('');

    const text = await setup().text();

    expect(text.split('\n').slice(0, 3)).toEqual([
      '- dialog "Outer"',
      '  - dialog "Inner"',
      expect.stringContaining('    - button "Deep"'),
    ]);

    expect(text.match(/"Inner"/g)).toHaveLength(1);
    expect(text).not.toMatch(/Hidden|Ghost|Shut/);
  });

  it('notes a dialog open outside a snapshot by ref, but not one the ref is inside', async () => {
    document.body.innerHTML = `<main><a href="/back">Back to Domain Portfolio</a></main>${DIALOG}`;

    const { text } = setup();
    const page = await text();
    const back = refOf(page, 'Back to Domain Portfolio');

    const outside = await text({ ref: back });

    expect(outside.split('\n').at(-1)).toBe(
      `… dialog "Edit nameservers" is open outside ${back}. Snapshot without a ref to read it.`,
    );

    expect(await text({ ref: refOf(page, 'Nameserver 1') })).not.toContain('is open outside');
  });
});

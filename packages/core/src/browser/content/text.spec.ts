// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/docs/page", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import { markOwn } from './dom';
import { refOf, setup, unwrap, useContentDom } from './harness';

useContentDom();

async function read(input: { ref?: string; doc?: string; max_chars?: number } = {}) {
  const { handlers } = setup();

  return unwrap(await handlers['page.text']({ max_chars: 30_000, ...input }));
}

describe('page text (sidekick-28 req. 3–5)', () => {
  it('reads main as markdown, with headings and absolute links, and leaves out the nav and hidden blocks', async () => {
    document.body.innerHTML = `
      <nav><a href="/home">Home</a> <a href="/pricing">Pricing</a></nav>
      <main>
        <h1>Install</h1>
        <p>Run <a href="setup.sh">the script</a> first.</p>
        <p style="display:none">Hidden by style</p>
        <p hidden>Hidden by attribute</p>
        <div aria-hidden="true">Hidden from readers</div>
        <p style="visibility:hidden">Invisible</p>
        <h2>Next</h2>
        <ul><li>One</li><li>Two</li></ul>
      </main>
      <footer>Copyright</footer>`;

    const page = await read();

    expect(page.title).toBe('Fixture');
    expect(page.truncated).toBe(false);
    expect(page.text).toContain('# Install');
    expect(page.text).toContain('## Next');
    expect(page.text).toContain('[the script](https://example.com/docs/setup.sh)');
    expect(page.text).toContain('One');

    for (const left of ['Home', 'Pricing', 'Hidden', 'Invisible', 'Copyright']) {
      expect(page.text).not.toContain(left);
    }
  });

  it('skips a hidden main, and picks the element with the most prose when nothing is marked main', async () => {
    document.body.innerHTML = `
      <main style="display:none"><p>Old main</p></main>
      <div class="menu"><p>Menu</p></div>
      <div class="story">
        <h1>Story</h1>
        <p>${'A long paragraph. '.repeat(20)}</p>
        <p>${'Another one. '.repeat(20)}</p>
      </div>`;

    const page = await read();

    expect(page.text).toContain('# Story');
    expect(page.text).not.toContain('Menu');
    expect(page.text).not.toContain('Old main');
  });

  it('never includes typed secrets, redacted fields or Sidekick’s own elements (req. 5)', async () => {
    document.body.innerHTML = `
      <article>
        <p>Checkout</p>
        <form>
          <label>Password <input type="password" value="attr-secret"></label>
          <label>Card <input autocomplete="cc-number"></label>
          <label>Note <textarea autocomplete="cc-csc">123</textarea></label>
        </form>
      </article>`;

    const password = document.querySelector<HTMLInputElement>('input[type=password]');
    const card = document.querySelector<HTMLInputElement>('input[autocomplete=cc-number]');

    if (!password || !card) throw new Error('Missing fixture fields');

    password.value = 'hunter2';
    card.value = '4242424242424242';

    const own = document.createElement('div');

    own.textContent = 'Stop Sidekick';
    markOwn(own);
    document.querySelector('article')?.append(own);

    const page = await read();

    expect(page.text).toContain('Checkout');

    for (const secret of ['hunter2', 'attr-secret', '4242424242424242', '123', 'Stop Sidekick']) {
      expect(page.text).not.toContain(secret);
    }
  });

  it('cuts 200,000 characters to max_chars at a line break, and says so (req. 2)', async () => {
    document.body.innerHTML = `<main>${'<p>The quick brown fox jumps over the lazy dog again.</p>'.repeat(4_000)}</main>`;

    const page = await read({ max_chars: 1_000 });

    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(1_000);
    expect(page.text.endsWith('again.')).toBe(true);
  });

  it('reads the ref’s element instead of main', async () => {
    document.body.innerHTML = `
      <main><p>Main text</p></main>
      <aside><button>Help</button><p>Aside text</p></aside>`;

    const { handlers, text } = setup();
    const ref = refOf(await text(), 'Help');

    const page = unwrap(await handlers['page.text']({ ref, max_chars: 30_000 }));

    expect(page.text).toBe('Help');
    expect(page.text).not.toContain('Main text');
  });
});

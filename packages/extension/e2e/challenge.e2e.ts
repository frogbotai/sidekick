import { expect, test } from './fixtures';

const TURNSTILE =
  'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2';

test('reports a Turnstile check and a block page, and nothing on an ordinary page (sidekick-14)', async ({
  context,
  origin,
  sidekick,
}) => {
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><input type="checkbox">' }),
  );

  await context.route('**/turnstile.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>shop.example</title><h1>shop.example</h1>
        <p>Verify you are human by completing the action below.</p>
        <iframe title="Widget containing a Cloudflare security challenge" src="${TURNSTILE}"></iframe>`,
    }),
  );

  const page = await context.newPage();

  await page.goto(`${origin()}/tabs.html`);

  const run = await sidekick.start(page);
  const clean = `${origin()}/tools.html`;

  expect(await run.call('navigate', { url: clean })).toEqual({
    url: clean,
    navigated: true,
    settled: true,
  });

  const wall = `${origin()}/turnstile.html`;

  expect(await run.call('navigate', { url: wall })).toMatchObject({
    url: wall,
    challenge: {
      vendor: 'cloudflare',
      kind: 'interactive',
      status: 'blocked',
      recommendation: 'handoff',
      message: expect.stringContaining('ask the person to solve it in this tab'),
    },
  });

  expect(await run.call('tabs_open', { url: `${origin()}/denied.html` })).toMatchObject({
    challenge: { vendor: 'generic', kind: 'block', recommendation: 'stop' },
  });
});

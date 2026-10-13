import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, OUTPUT, test } from './fixtures';

const API = 'https://llm.fixture.test/v1';

const chunk = (delta: Record<string, string>, finish: string | null) =>
  `data: ${JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'echo',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const STREAM = [
  chunk({ role: 'assistant', content: 'Hello' }, null),
  chunk({ content: ' from the fixture' }, 'stop'),
  'data: [DONE]\n\n',
].join('');

async function panelSource(build: string) {
  const chunks = path.join(build, 'chunks');
  const files = (await readdir(chunks)).filter((file) => file.endsWith('.js'));

  return (await Promise.all(files.map((file) => readFile(path.join(chunks, file), 'utf8')))).join(
    '\n',
  );
}

test('ships the AI SDK in the panel without the gateway, OIDC or zod’s other locales', async ({
  extensionBuild,
}) => {
  const build = path.join(OUTPUT, extensionBuild);
  const panel = await panelSource(build);
  const background = await readFile(path.join(build, 'background.js'), 'utf8');

  expect(panel).toContain('OPENAI_API_KEY');
  expect(panel).toContain('Sidekick has no AI Gateway');
  expect(panel).not.toContain('ai-gateway.vercel.sh');
  expect(panel).not.toContain('@vercel/request-context');
  expect(panel).not.toContain('getVercelToken');

  for (const word of ['Ungültige Eingabe', 'Entrée invalide', 'Entrada inválida', '无效输入']) {
    expect(panel).not.toContain(word);
  }

  expect(background).not.toContain('OPENAI_API_KEY');
});

test('streams from a custom provider through the captured fetch', async ({
  context,
  openPanel,
}) => {
  const authorizations: (string | undefined)[] = [];

  await context.route(`${API}/**`, (route) => {
    const request = route.request();

    authorizations.push(request.headers().authorization);

    if (request.url().endsWith('/models')) {
      return route.fulfill({ json: { data: [{ id: 'echo' }] } });
    }

    return route.fulfill({ contentType: 'text/event-stream', body: STREAM });
  });

  const panel = await openPanel();

  await panel.waitForFunction(() => 'sidekick' in window);

  await panel.evaluate(
    (baseURL) =>
      window.sidekick.provider.addCustomProvider({ name: 'Fixture', baseURL, key: 'fixture-key' }),
    API,
  );

  await expect
    .poll(() =>
      panel.evaluate(() =>
        window.sidekick.provider.resolveModel('fixture/echo', {}).then(
          () => true,
          () => false,
        ),
      ),
    )
    .toBe(true);

  const reply = await panel.evaluate(async () => {
    const { provider, streamText } = window.sidekick;

    window.fetch = () => Promise.reject(new Error('the patched fetch saw the key'));

    const result = streamText({
      model: await provider.resolveModel('fixture/echo', {}),
      prompt: 'hi',
    });

    let text = '';

    for await (const part of result.textStream) text += part;

    return text;
  });

  expect(reply).toBe('Hello from the fixture');
  expect(new Set(authorizations)).toEqual(new Set(['Bearer fixture-key']));
});

import { expect, refFor, type SnapshotOutput, test } from './fixtures';

const PDF = '%PDF-1.7 resume';

test('uploads a file to a file input, and refuses a text field, no files and 6 MiB untouched', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/upload.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot');
  const resume = refFor(snapshot, 'Resume');
  const chosen = () =>
    page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#resume');

      return Array.from(input?.files ?? []).map(({ name, type, size }) => ({ name, type, size }));
    });

  expect(await run.fail('upload', { ref: refFor(snapshot, 'Full name'), files: [] })).toMatchObject(
    { code: 'invalid_input' },
  );

  expect(
    await run.fail('upload', {
      ref: refFor(snapshot, 'Full name'),
      files: [{ name: 'resume.pdf', mimeType: 'application/pdf', data: btoa(PDF) }],
    }),
  ).toMatchObject({ code: 'invalid_target' });

  expect(
    await run.fail('upload', {
      ref: resume,
      files: [
        { name: 'big.bin', mimeType: 'application/octet-stream', data: 'AAAA'.repeat(2_097_152) },
      ],
    }),
  ).toMatchObject({ code: 'invalid_input' });

  expect(await chosen()).toEqual([]);
  expect(await page.evaluate(() => window.changes)).toBe(0);

  const uploaded = await run.call('upload', {
    ref: resume,
    files: [{ name: 'resume.pdf', mimeType: 'application/pdf', data: btoa(PDF) }],
  });

  expect(uploaded).toMatchObject({ files: 1, navigated: false, dialog: null });

  expect(await chosen()).toEqual([
    { name: 'resume.pdf', type: 'application/pdf', size: PDF.length },
  ]);

  expect(await page.evaluate(() => window.changes)).toBe(1);
  await expect(page.locator('#chosen')).toHaveText('resume.pdf');
});

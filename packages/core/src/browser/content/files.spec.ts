// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import { ToolError } from '../../tool/tool';
import { failure, refOf, setup, unwrap, useContentDom } from './harness';

useContentDom();

const RESUME = { name: 'resume.pdf', mimeType: 'application/pdf', data: btoa('%PDF-1.7') };
const PHOTO = { name: 'photo.png', mimeType: 'image/png', data: btoa('png') };

function inputNamed(label: string) {
  const input = document.querySelector(`input[aria-label="${label}"]`);

  if (!(input instanceof HTMLInputElement)) throw new Error(`No input ${label}`);

  return input;
}

function events(input: HTMLInputElement) {
  const seen: string[] = [];

  for (const type of ['input', 'change']) input.addEventListener(type, () => seen.push(type));

  return seen;
}

describe('setting files on a file input (16 req. 9–11)', () => {
  it('sets the files with their name, type and bytes, then fires input and change once each', async () => {
    document.body.innerHTML = '<input type="file" multiple aria-label="Documents">';

    const input = inputNamed('Documents');
    const seen = events(input);
    const { handlers, text } = setup();
    const ref = refOf(await text(), 'Documents');

    expect(unwrap(await handlers['page.setFiles']({ ref, files: [RESUME, PHOTO] }))).toBe(2);
    expect(seen).toEqual(['input', 'change']);

    const [first, second] = Array.from(input.files ?? []);

    expect([first?.name, first?.type, first?.size]).toEqual(['resume.pdf', 'application/pdf', 8]);
    expect(await first?.text()).toBe('%PDF-1.7');
    expect(second?.name).toBe('photo.png');
  });

  it('refuses a non-file input, a disabled one and two files for a single input, setting nothing', async () => {
    document.body.innerHTML = [
      '<input type="text" aria-label="Name">',
      '<input type="file" disabled aria-label="Locked">',
      '<input type="file" aria-label="Resume">',
    ].join('');

    const { handlers, text } = setup();
    const snapshot = await text();
    const set = async (label: string, files = [RESUME]) =>
      failure(
        (async () =>
          unwrap(await handlers['page.setFiles']({ ref: refOf(snapshot, label), files })))(),
      );

    const notFile = await set('Name');
    const disabled = await set('Locked');
    const two = await set('Resume', [RESUME, PHOTO]);

    expect(notFile).toBeInstanceOf(ToolError);
    expect(notFile instanceof ToolError && notFile.message).toContain('isn’t a file input');
    expect(disabled instanceof ToolError && disabled.message).toContain('disabled');
    expect(two instanceof ToolError && two.code).toBe('invalid_input');
    expect(inputNamed('Locked').files?.length ?? 0).toBe(0);
    expect(inputNamed('Resume').files?.length ?? 0).toBe(0);
  });
});

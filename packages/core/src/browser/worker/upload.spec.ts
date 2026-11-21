import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { MAX_UPLOAD_BYTES, SCRIPT_SET_FILES } from './tools/upload';
import type { FileData } from './types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const RESUME = { name: 'resume.pdf', mimeType: 'application/pdf', data: btoa('%PDF-1.7') };

function base64Of(bytes: number) {
  const tail = ['', 'AA==', 'AAA='][bytes % 3] ?? '';

  return 'AAAA'.repeat(Math.floor(bytes / 3)) + tail;
}

function messageOf(error: unknown) {
  return error instanceof ToolError ? `${error.code}: ${error.message}` : String(error);
}

describe('upload (16 req. 9–11)', () => {
  it('asks for input, checks the ref, sets the files, settles, and reports the count with a warning', async () => {
    const { tool, ctx, log } = await setupBrowser();

    const { output } = await drain(
      tool('upload').execute({ tab_id: 1, ref: 'f0e1', files: [RESUME] }, ctx),
    );

    expect(ctx.asserts).toEqual([{ action: 'input', resource: 'https://example.com' }]);
    expect(log.indexOf('page.inspect')).toBeLessThan(log.indexOf('page.setFiles'));
    expect(log.indexOf('page.setFiles')).toBeLessThan(log.indexOf('page.domQuiet'));

    expect(output).toEqual({
      url: 'https://example.com/',
      navigated: false,
      urlChanged: false,
      settled: true,
      newTabs: [],
      dialog: null,
      files: 1,
      note: SCRIPT_SET_FILES,
    });
  });

  it('sends the files as base64, dropping a data: prefix and line breaks', async () => {
    const sent: FileData[][] = [];
    const { tool, ctx } = await setupBrowser({
      page: {
        setFiles: later((_tabId: number, _ref: string, files: FileData[]) => {
          sent.push(files);

          return files.length;
        }),
      },
    });

    await drain(
      tool('upload').execute(
        {
          tab_id: 1,
          ref: 'f0e1',
          files: [
            {
              ...RESUME,
              data: `data:application/pdf;base64,${RESUME.data.slice(0, 4)}\n${RESUME.data.slice(4)}`,
            },
          ],
        },
        ctx,
      ),
    );

    expect(sent).toEqual([[RESUME]]);
  });

  it.each([
    ['no files', [], 'Send at least one file'],
    ['a total over 5 MiB', [{ ...RESUME, data: base64Of(MAX_UPLOAD_BYTES + 1) }], 'at most 5 MiB'],
    [
      'two files over 5 MiB together',
      [
        { ...RESUME, data: base64Of(3 * 1024 * 1024) },
        { ...RESUME, data: base64Of(3 * 1024 * 1024) },
      ],
      '6.0 MiB',
    ],
    ['bad base64', [{ ...RESUME, data: 'not base64!' }], 'isn’t valid base64'],
    ['a chat file outside the panel', [{ attachment: 'resume.pdf' }], 'as base64 instead'],
  ])('rejects %s before asking or touching the page', async (_case, files, message) => {
    const { tool, ctx, log } = await setupBrowser();

    const error = await failure(tool('upload').execute({ tab_id: 1, ref: 'f0e1', files }, ctx));

    expect(messageOf(error)).toMatch(/^invalid_input: /);
    expect(messageOf(error)).toContain(message);
    expect(log).toEqual([]);
  });

  it('says to send less when over 5 MiB, not to attach the files, which hit the same cap', async () => {
    const { tool, ctx } = await setupBrowser();
    const files = [{ ...RESUME, data: base64Of(MAX_UPLOAD_BYTES + 1) }];
    const error = await failure(tool('upload').execute({ tab_id: 1, ref: 'f0e1', files }, ctx));

    expect(messageOf(error)).toContain('Send fewer or smaller files');
    expect(messageOf(error)).not.toMatch(/attach/i);
  });

  it('takes exactly 5 MiB', async () => {
    const { tool, ctx } = await setupBrowser();

    const { output } = await drain(
      tool('upload').execute(
        { tab_id: 1, ref: 'f0e1', files: [{ ...RESUME, data: base64Of(MAX_UPLOAD_BYTES) }] },
        ctx,
      ),
    );

    expect(output).toMatchObject({ files: 1 });
  });

  it('passes on the page’s refusal of a ref that isn’t a file input', async () => {
    const { tool, ctx } = await setupBrowser({
      page: {
        setFiles: later(() => {
          throw new ToolError('invalid_target', 'f0e1 isn’t a file input.');
        }),
      },
    });

    const error = await failure(
      tool('upload').execute({ tab_id: 1, ref: 'f0e1', files: [RESUME] }, ctx),
    );

    expect(error).toMatchObject({ code: 'invalid_target' });
  });

  it('is refused, and sets nothing, when input is denied', async () => {
    const { tool, ctx, log } = await setupBrowser();

    ctx.permission.assert = later((request) => {
      ctx.asserts.push(request);

      throw new ToolError('denied', 'Denied.');
    });

    const error = await failure(
      tool('upload').execute({ tab_id: 1, ref: 'f0e1', files: [RESUME] }, ctx),
    );

    expect(error).toMatchObject({ code: 'denied' });
    expect(log).not.toContain('page.setFiles');
  });

  it('ends at once with the dialog when the page’s change handler raises one', async () => {
    const setup = await setupBrowser();
    const { tool, ctx, cdp } = setup;

    setup.page.setFiles = later(() => {
      cdp.openDialog(1, { type: 'alert', message: 'Only PDFs, please' });

      return 1;
    });

    const { output } = await drain(
      tool('upload').execute({ tab_id: 1, ref: 'f0e1', files: [RESUME] }, ctx),
    );

    expect(output).toMatchObject({
      settled: false,
      dialog: { type: 'alert', message: 'Only PDFs, please', defaultValue: '' },
    });
  });
});

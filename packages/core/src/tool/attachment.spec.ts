import { describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '../session/schema';
import { attachedFile, withAttachments } from './attachment';
import { type SidekickClient, workerTools } from './proxy';
import { type ToolContext, ToolError } from './tool';

function user(
  id: string,
  parts: Extract<SessionMessage, { type: 'user' }>['parts'],
): SessionMessage {
  return { type: 'user', id, sessionID: 'ses-1', seq: 0, time: { created: 0 }, parts };
}

function file(filename: string, data: string, mediaType = 'application/pdf') {
  return { type: 'file' as const, mediaType, url: `data:${mediaType};base64,${data}`, filename };
}

const MESSAGES = [
  user('m1', [file('resume.pdf', 'b2xk')]),
  user('m2', [
    { type: 'text', text: 'here' },
    file('resume.pdf', 'bmV3'),
    file('photo.png', 'cG5n', 'image/png'),
  ]),
  user('m3', [
    { type: 'file', mediaType: 'image/png', url: 'https://a.test/x.png', filename: 'remote.png' },
  ]),
];

function context(): ToolContext {
  return {
    signal: new AbortController().signal,
    session: { id: 'ses-2', rootID: 'ses-1' },
    messageID: 'msg-1',
    callID: 'call-1',
    agent: 'build',
    permission: { assert: () => Promise.resolve() },
  };
}

describe('chat attachments for upload (16 req. 9)', () => {
  it('finds the newest user file by name as base64, and nothing for a remote or unknown name', () => {
    expect(attachedFile(MESSAGES, 'resume.pdf')).toEqual({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      data: 'bmV3',
    });

    expect(attachedFile(MESSAGES, 'photo.png')?.mimeType).toBe('image/png');
    expect(attachedFile(MESSAGES, 'missing.pdf')).toBeUndefined();
  });

  it('stops at the newest file by that name, even when its data: URL carries a charset', () => {
    const messages = [
      user('m1', [file('notes.txt', 'b2xk', 'text/plain')]),
      user('m2', [
        {
          type: 'file',
          mediaType: 'text/plain',
          url: 'data:text/plain;charset=utf-8;base64,bmV3',
          filename: 'notes.txt',
        },
      ]),
    ];

    expect(attachedFile(messages, 'notes.txt')?.data).toBe('bmV3');
  });

  it('fails, saying why, when the newest file by that name isn’t stored in the chat', () => {
    const messages = [user('m1', [file('remote.png', 'b2xk', 'image/png')]), ...MESSAGES.slice(2)];

    expect(() => attachedFile(messages, 'remote.png')).toThrow(/send the file as base64/);
  });

  it('resolves pasted text, the panel’s attachment, as a text file by its name', () => {
    const messages = [
      user('m1', [{ type: 'data-paste', data: { text: 'héllo', filename: 'Pasted text.txt' } }]),
    ];

    expect(attachedFile(messages, 'Pasted text.txt')).toEqual({
      name: 'Pasted text.txt',
      mimeType: 'text/plain',
      data: 'aMOpbGxv',
    });
  });

  it('replaces each { attachment } and leaves base64 files and other fields alone', async () => {
    const find = (name: string) => Promise.resolve(attachedFile(MESSAGES, name));
    const sent = { name: 'a.txt', mimeType: 'text/plain', data: 'YQ==' };

    expect(
      await withAttachments(
        { tab_id: 1, ref: 'f0e1', files: [{ attachment: 'photo.png' }, sent] },
        find,
      ),
    ).toEqual({
      tab_id: 1,
      ref: 'f0e1',
      files: [{ name: 'photo.png', mimeType: 'image/png', data: 'cG5n' }, sent],
    });
  });

  it('resolves an { attachment } that carries other keys too', async () => {
    const find = (name: string) => Promise.resolve(attachedFile(MESSAGES, name));

    expect(
      await withAttachments({ files: [{ attachment: 'photo.png', name: 'photo.png' }] }, find),
    ).toEqual({ files: [{ name: 'photo.png', mimeType: 'image/png', data: 'cG5n' }] });
  });

  it('fails with what to do when the chat has no file by that name', async () => {
    const error = await withAttachments({ files: [{ attachment: 'missing.pdf' }] }, () =>
      Promise.resolve(undefined),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(error instanceof ToolError && error.message).toContain('send the file as base64');
  });

  it('resolves attachments in the panel’s proxy before the worker gets the call', async () => {
    const calls: unknown[] = [];
    const call = vi.fn((method: string, input: unknown) => {
      if (method === 'tool.list') {
        return Promise.resolve([
          { id: 'upload', description: 'Upload', permission: 'input', input: {}, output: {} },
        ]);
      }

      calls.push(input);

      return Promise.resolve({ ok: { output: {} } });
    });

    const client = { call, on: () => () => undefined } as SidekickClient;
    const lookups: [string, string | undefined][] = [];

    const [upload] = await workerTools(client, {
      attachment: (name, ctx) => {
        lookups.push([name, ctx.session.rootID]);

        return Promise.resolve(attachedFile(MESSAGES, name));
      },
    });

    await upload?.execute(
      { tab_id: 1, ref: 'f0e1', files: [{ attachment: 'resume.pdf' }] },
      context(),
    );

    expect(lookups).toEqual([['resume.pdf', 'ses-1']]);

    expect(calls).toEqual([
      expect.objectContaining({
        tool: 'upload',
        input: {
          tab_id: 1,
          ref: 'f0e1',
          files: [{ name: 'resume.pdf', mimeType: 'application/pdf', data: 'bmV3' }],
        },
      }),
    ]);
  });
});

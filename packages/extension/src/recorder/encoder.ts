import type { Encoder } from '@frogbotai/sidekick-core';

import {
  type Finished,
  isFinished,
  isReply,
  RECORDER_DOCUMENT,
  RECORDER_PORT,
  type RecorderReply,
  type RecorderRequest,
} from './messages';

/** How long a finished recording's download may take before its blob URL is revoked anyway. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

type Request = RecorderRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never;

async function hasDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(RECORDER_DOCUMENT)],
  });

  return contexts.length > 0;
}

function downloaded(downloadId: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      const state = delta.state?.current;

      if (delta.id === downloadId && (state === 'complete' || state === 'interrupted')) done();
    };

    const timer = setTimeout(done, DOWNLOAD_TIMEOUT_MS);

    chrome.downloads.onChanged.addListener(onChanged);

    void chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item && item.state !== 'in_progress') done();
    });
  });
}

/**
 * Encodes in an offscreen document, because WebCodecs isn't exposed to service workers, and
 * downloads from here, because `chrome.downloads` isn't exposed to offscreen documents. The
 * document stays open while any recording or download needs it, which also keeps this worker awake.
 */
export function chromeEncoder(): Encoder {
  const waiting = new Map<number, (reply: RecorderReply) => void>();
  const users = new Set<string>();
  let port: Promise<chrome.runtime.Port> | undefined;
  let closing = Promise.resolve();
  let next = 0;

  const connect = async () => {
    await closing;

    if (!(await hasDocument())) {
      await chrome.offscreen.createDocument({
        url: RECORDER_DOCUMENT,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Encode tab recordings to MP4 with WebCodecs, which service workers lack.',
      });
    }

    const opened = chrome.runtime.connect({ name: RECORDER_PORT });

    opened.onMessage.addListener((reply: unknown) => {
      if (!isReply(reply)) return;

      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    });

    opened.onDisconnect.addListener(() => {
      port = undefined;

      for (const [id, resolve] of waiting) resolve({ id, error: 'The recorder closed' });

      waiting.clear();
    });

    return opened;
  };

  const request = async (message: Request) => {
    port ??= connect();

    const opened = await port.catch((error: unknown) => {
      port = undefined;

      throw error;
    });

    const id = next++;
    const reply = new Promise<RecorderReply>((resolve) => waiting.set(id, resolve));

    opened.postMessage({ ...message, id });

    const answer = await reply;

    if ('error' in answer) throw new Error(answer.error);

    return answer.ok;
  };

  const release = (user: string) => {
    users.delete(user);

    if (users.size > 0) return;

    closing = closing
      .then(async () => {
        if (users.size > 0) return;

        const open = await port?.catch(() => undefined);

        port = undefined;
        open?.disconnect();

        if (await hasDocument()) await chrome.offscreen.closeDocument();
      })
      .catch(() => undefined);
  };

  const save = async (finished: Finished, file: string) => {
    const user = finished.url;

    users.add(user);

    try {
      const downloadId = await chrome.downloads.download({
        url: finished.url,
        filename: file,
        saveAs: false,
        conflictAction: 'uniquify',
      });

      await downloaded(downloadId);
    } finally {
      await request({ type: 'revoke', url: finished.url }).catch(() => undefined);
      release(user);
    }
  };

  return {
    open: async (recording, { frameRate }) => {
      users.add(recording);

      try {
        await request({ type: 'open', recording, frameRate });
      } catch (error) {
        release(recording);

        throw error;
      }
    },
    frame: async (recording, frame) => {
      await request({ type: 'frame', recording, ...frame });
    },
    close: async (recording, file) => {
      try {
        const finished = await request({ type: 'close', recording });

        if (!isFinished(finished)) throw new Error('The recorder sent no file');

        await save(finished, file);

        return {
          file,
          codec: finished.codec,
          bytes: finished.bytes,
          width: finished.width,
          height: finished.height,
        };
      } finally {
        release(recording);
      }
    },
    cancel: async (recording) => {
      if (!users.has(recording)) return;

      try {
        await request({ type: 'cancel', recording });
      } finally {
        release(recording);
      }
    },
  };
}

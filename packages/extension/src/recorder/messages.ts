/** The port the service worker opens to the offscreen recorder document. */
export const RECORDER_PORT = 'sidekick-recorder';

/** The offscreen document's page, built from `entrypoints/offscreen`. */
export const RECORDER_DOCUMENT = 'offscreen.html';

/** What the service worker asks the recorder document, one reply per `id`. */
export type RecorderRequest = { id: number } & (
  | { type: 'open'; recording: string; frameRate: number }
  | { type: 'frame'; recording: string; data: string; timestamp: number; duration: number }
  | { type: 'close'; recording: string }
  | { type: 'cancel'; recording: string }
  | { type: 'revoke'; url: string }
);

export type RecorderReply = { id: number } & ({ ok: unknown } | { error: string });

/** A finished MP4, held as a blob URL until the download completes. */
export interface Finished {
  url: string;
  codec: string;
  bytes: number;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isReply(value: unknown): value is RecorderReply {
  return isRecord(value) && typeof value.id === 'number' && ('ok' in value || 'error' in value);
}

export function isRequest(value: unknown): value is RecorderRequest {
  return isRecord(value) && typeof value.id === 'number' && typeof value.type === 'string';
}

export function isFinished(value: unknown): value is Finished {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.codec === 'string' &&
    typeof value.bytes === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
}

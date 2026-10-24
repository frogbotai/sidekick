import {
  allFileName,
  exportFileName,
  exportLines,
  type ExportReader,
} from '@frogbotai/sidekick-core';

/** Saves lines as one JSON file through a Blob and `<a download>`, as OpenCode v2 does; no permission. */
export function downloadLines(name: string, lines: readonly string[]) {
  const blob = new Blob(
    lines.map((line) => `${line}\n`),
    { type: 'application/json' },
  );

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** One chat and its subagent sessions, messages only (328 D2), as `<slug>.json`. */
export async function exportChat(reader: ExportReader, sessionID: string, save = downloadLines) {
  const info = await reader.sessions.get(sessionID);

  if (!info) throw new Error('This chat no longer exists.');

  save(exportFileName(info), await exportLines(reader, [info]));
}

/** Every chat and its subagent sessions, messages only, as `sidekick-sessions-<date>.json`. */
export async function exportAll(reader: ExportReader, save = downloadLines, now = Date.now) {
  save(allFileName(now()), await exportLines(reader, await reader.sessions.list(), { now }));
}

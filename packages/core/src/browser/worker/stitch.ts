/** One frame's outline as the content script returns it. */
export interface FrameOutline {
  title: string;
  lines: { depth: number; text: string; frame?: number; redacted?: boolean }[];
  truncated: boolean;
}

export interface Stitched {
  text: string;
  redacted: number;
  truncated: boolean;
}

export function truncationNote(maxChars: number) {
  return `[Truncated at ${maxChars.toLocaleString('en-US')} characters. Snapshot one element with ref, or scroll and snapshot the viewport.]`;
}

/**
 * Nests each child frame's outline under its `<iframe>` line; a frame that couldn't be read
 * (`undefined`) stays that one line. Counts only the redacted lines it keeps.
 */
export function stitch(
  frames: Map<number, FrameOutline | undefined>,
  start: number,
  maxChars: number,
): Stitched {
  const out: string[] = [];
  const seen = new Set<number>();
  const state = { chars: 0, redacted: 0, full: false, partial: false };

  const push = (depth: number, text: string, redacted = false) => {
    if (state.full) return false;

    const line = `${'  '.repeat(depth)}${text}`;

    if (state.chars + line.length + 1 > maxChars) {
      state.full = true;

      return false;
    }

    state.chars += line.length + 1;
    out.push(line);

    if (redacted) state.redacted++;

    return true;
  };

  const render = (frameId: number, base: number) => {
    const outline = frames.get(frameId);

    if (!outline) return;

    seen.add(frameId);

    if (outline.truncated) state.partial = true;

    for (const line of outline.lines) {
      if (line.frame === undefined) {
        push(base + line.depth, line.text, line.redacted);
        continue;
      }

      const child = seen.has(line.frame) ? undefined : frames.get(line.frame);

      if (!child) {
        push(base + line.depth, `${line.text} (not readable)`);
        continue;
      }

      if (push(base + line.depth, line.text)) render(line.frame, base + line.depth + 1);
    }
  };

  render(start, 0);

  const truncated = state.full || state.partial;
  const text = out.join('\n');

  return {
    text: truncated ? `${text}\n${truncationNote(maxChars)}` : text,
    redacted: state.redacted,
    truncated,
  };
}

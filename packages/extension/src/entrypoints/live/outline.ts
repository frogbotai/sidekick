/** One interactive line of a snapshot: `- textbox "Search" value="x" (disabled) [f0e3]`. */
export interface OutlineItem {
  role: string;
  name: string;
  value?: string;
  ref: string;
  frame: number;
}

const LINE =
  /^\s*- (\S+) ("(?:[^"\\]|\\.)*")(?: value=(\[redacted\]|"(?:[^"\\]|\\.)*"))?(?: \([^)]*\))? \[(f(\d+)e\d+)\]$/;

function unquote(text: string) {
  try {
    return String(JSON.parse(text));
  } catch {
    return text;
  }
}

/** The refs in a snapshot, in order. */
export function outline(snapshot: string): OutlineItem[] {
  return snapshot.split('\n').flatMap((line) => {
    const match = LINE.exec(line);

    if (!match) return [];

    const [, role = '', name = '', value, ref = '', frame = '0'] = match;

    return [
      {
        role,
        name: unquote(name),
        ...(value === undefined ? {} : { value: value.startsWith('"') ? unquote(value) : value }),
        ref,
        frame: Number(frame),
      },
    ];
  });
}

/** Share of the refs in `before` that name the same role and name in `after`. */
export function stability(before: OutlineItem[], after: OutlineItem[]) {
  if (before.length === 0) return 1;

  const now = new Map(after.map((item) => [item.ref, item]));

  const kept = before.filter((item) => {
    const match = now.get(item.ref);

    return match?.role === item.role && match.name === item.name;
  });

  return kept.length / before.length;
}

/** The `iframe` lines in a snapshot, and how many of them say `(not readable)`. */
export function iframes(snapshot: string) {
  const lines = snapshot.split('\n').filter((line) => /^\s*- iframe /.test(line));

  return {
    all: lines.length,
    unreadable: lines.filter((line) => line.endsWith('(not readable)')).length,
  };
}

export function tokens(text: string) {
  return Math.round(text.length / 4);
}

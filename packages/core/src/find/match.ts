/** At most this many matches come back from one `find`. */
export const FIND_MAX_MATCHES = 10;

/** Each match's reason is cut to this many characters. */
export const FIND_REASON_MAX_LENGTH = 120;

/** Each match's element line is cut to this many characters, before its ref. */
export const FIND_ELEMENT_MAX_LENGTH = 160;

const ELEMENT = /^\s*- (.*?)\s*\[(f\d+e\d+)\]\s*$/;

const REF = /\bf\d+e\d+\b/;

const LEAD = /^[\s\]—–:,.-]+/;

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Each ref in a snapshot outline, with its element line (`button "Submit"`) without the ref. */
export function outlineElements(outline: string) {
  const elements = new Map<string, string>();

  for (const line of outline.split('\n')) {
    const found = ELEMENT.exec(line);

    if (found?.[1] && found[2]) elements.set(found[2], found[1]);
  }

  return elements;
}

/**
 * The matcher's `<ref> — <reason>` lines as `role "name" [ref] — reason`, keeping only refs the
 * outline has, once each, and at most `FIND_MAX_MATCHES`.
 */
export function parseMatches(reply: string, outline: string) {
  const elements = outlineElements(outline);
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const line of reply.split('\n')) {
    const found = REF.exec(line);
    const ref = found?.[0];

    if (!ref || seen.has(ref)) continue;

    const element = elements.get(ref);

    if (element === undefined) continue;

    seen.add(ref);

    const reason = clip(
      line
        .slice((found.index ?? 0) + ref.length)
        .replace(LEAD, '')
        .trim(),
      FIND_REASON_MAX_LENGTH,
    );

    const head = `${clip(element, FIND_ELEMENT_MAX_LENGTH)} [${ref}]`;

    matches.push(reason ? `${head} — ${reason}` : head);

    if (matches.length === FIND_MAX_MATCHES) break;
  }

  return matches;
}

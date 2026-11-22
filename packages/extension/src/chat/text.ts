const TEXT_LIMIT = 40;

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

export function count(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function short(value: string) {
  const line = value.replace(/\s+/g, ' ').trim();

  return line.length > TEXT_LIMIT ? `${line.slice(0, TEXT_LIMIT).trimEnd()}…` : line;
}

export function web(url: string | undefined) {
  return url !== undefined && /^https?:\/\//i.test(url);
}

/** A URL's host without `www.`, or the URL when it has none. */
export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

export function joined(...words: (string | undefined)[]) {
  return words.filter(Boolean).join(' ');
}

/** The overrides an `emulate` call sets, as a phrase like “390×844 phone, dark mode”. */
export function emulated(input: Record<string, unknown>) {
  const viewport = record(input.viewport);
  const size =
    typeof viewport.width === 'number' && typeof viewport.height === 'number'
      ? joined(`${viewport.width}×${viewport.height}`, viewport.mobile === true ? 'phone' : '')
      : undefined;

  const motion = text(input.reduced_motion);

  return [
    size,
    text(input.color_scheme) && `${text(input.color_scheme)} mode`,
    motion && (motion === 'reduce' ? 'reduced motion' : 'full motion'),
    text(input.user_agent) && 'another user agent',
    Object.keys(record(input.geolocation)).length > 0 && 'another location',
  ]
    .filter((part) => typeof part === 'string' && part)
    .join(', ');
}

/** What a `wait_for` call waits for, as a phrase like “Done” to go away. */
export function waitedFor(input: Record<string, unknown>, target: string | undefined) {
  const quote = (value: unknown) => `“${short(text(value) ?? '')}”`;

  if (text(input.text)) return quote(input.text);

  if (text(input.text_gone)) return `${quote(input.text_gone)} to go away`;

  if (text(input.url)) return `the URL to contain ${quote(input.url)}`;

  if (text(input.ref)) {
    return `${target ?? 'an element'} to ${input.state === 'hidden' ? 'hide' : 'show'}`;
  }

  return 'the page to load';
}

/** The files an `upload` call sets, as “resume.pdf” or “2 files”. */
export function uploaded(input: Record<string, unknown>) {
  const names = (Array.isArray(input.files) ? input.files : []).flatMap((file) => {
    const name = text(record(file).name) ?? text(record(file).attachment);

    return name ? [name] : [];
  });

  return names.length === 1 ? `“${short(names[0] ?? '')}”` : plural(names.length, 'file');
}

/** The verb forms for a click, as running, done and failed. */
export function clickVerb(input: Record<string, unknown>) {
  if (input.button === 'right') return ['Right-clicking', 'Right-clicked', 'Right-click'];

  if (input.count === 2) return ['Double-clicking', 'Double-clicked', 'Double-click'];

  if (input.count === 3) return ['Triple-clicking', 'Triple-clicked', 'Triple-click'];

  return ['Clicking', 'Clicked', 'Click'];
}

/** The title of the tab with `tabId` in a tabs listing. */
export function tabTitle(output: Record<string, unknown>, tabId: unknown) {
  const tabs = Array.isArray(output.tabs) ? output.tabs.map(record) : [];

  return text(tabs.find((tab) => tab.tab_id === tabId)?.title);
}

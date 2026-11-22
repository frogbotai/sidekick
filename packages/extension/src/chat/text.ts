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

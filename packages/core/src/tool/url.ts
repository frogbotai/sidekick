import { ToolError } from './tool';

const LOCAL = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

const PATH = /^(?:[\\/.]|[a-zA-Z]:[\\/])/;

function invalid(value: string) {
  return new ToolError(
    'invalid_target',
    `"${value}" is not a web URL. Use an http(s) URL or about:blank, without credentials.`,
  );
}

export function normalizeUrl(input: string): string {
  const value = input.trim() || 'about:blank';

  if (PATH.test(value)) throw invalid(value);

  let url: URL;

  try {
    const local = LOCAL.test(value);

    url = new URL(
      value === 'about:blank' || SCHEME.test(value)
        ? value
        : `${local ? 'http' : 'https'}://${value}`,
    );
  } catch {
    throw invalid(value);
  }

  const web = url.href === 'about:blank' || /^https?:$/.test(url.protocol);

  if (!web || url.username || url.password) throw invalid(value);

  return url.href;
}

export function originOf(url: string): string {
  try {
    const { origin, href } = new URL(url);

    return origin === 'null' ? href : origin;
  } catch {
    return url;
  }
}

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

/**
 * The site a grant or rule names, after Claude for Chrome's `matchesNetloc`: an http(s) origin's
 * lowercased host and port, without a trailing dot or a leading `www.`. Anything else stays raw.
 */
export function siteOf(resource: string): string {
  if (!/^https?:\/\//i.test(resource)) return resource;

  try {
    const { hostname, port } = new URL(resource);
    const host = hostname.replace(/\.$/, '').replace(/^www\./, '');

    return port ? `${host}:${port}` : host;
  } catch {
    return resource;
  }
}

/** Whether a permission resource is a web origin, so blocked and sensitive sites apply to it. */
export function isWebOrigin(resource: string) {
  return /^https?:\/\//i.test(resource);
}

export function originOf(url: string): string {
  try {
    const { origin, href } = new URL(url);

    return origin === 'null' ? href : origin;
  } catch {
    return url;
  }
}

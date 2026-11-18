/** Names of headers, fields and cookies whose values are credentials. */
export const SECRET_NAME =
  /auth(?:orization)?|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|otp|(?:^|[-_.])code(?:$|[-_.])|(?:api|access|refresh)[-_.]?key|signature|(?:^|[-_.])sig(?:$|[-_.])/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a URL path segment looks like a credential: a JWT, long hex, or long high-entropy base64. */
export function looksLikeToken(segment: string): boolean {
  if (segment.length < 24 || UUID.test(segment) || segment.includes('${')) return false;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(segment)) return true;
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true;
  if (!/^[A-Za-z0-9_~+/-]+={0,2}$/.test(segment)) return false;
  if (/^[a-z]+(?:[-_][a-z]+)+$/i.test(segment)) return false;

  const digit = /\d/.test(segment);
  const lower = /[a-z]/.test(segment);
  const upper = /[A-Z]/.test(segment);

  return (
    new Set(segment).size >= 12 &&
    digit &&
    (lower || upper) &&
    ((lower && upper) || segment.length >= 32)
  );
}

function decode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Replaces token-like segments of a URL path. */
export function protectPathSegments(pathname: string, protect: (segment: string) => string) {
  return pathname
    .split('/')
    .map((segment) => {
      const decoded = decode(segment);

      return looksLikeToken(decoded) ? protect(decoded) : segment;
    })
    .join('/');
}

/** A copy of `params` with the values of secret-named fields replaced. */
export function protectSearchParams(
  params: URLSearchParams,
  protect: (name: string, value: string) => string,
) {
  const result = new URLSearchParams();

  for (const [name, value] of params) {
    result.append(name, value && SECRET_NAME.test(name) ? protect(name, value) : value);
  }

  return result;
}

/** Replaces secret-named `name=value` pairs in a URL fragment, leaving route and anchor text. */
export function protectFragment(
  fragment: string,
  protect: (name: string, value: string) => string,
) {
  return fragment
    .split('&')
    .map((part) => {
      const separator = part.indexOf('=');

      if (separator < 1) return part;

      const entry = new URLSearchParams(part).entries().next().value;

      if (!entry) return part;

      const [name, value] = entry;

      if (!/^[\w.-]+$/.test(name) || !SECRET_NAME.test(name) || !value) return part;

      return `${part.slice(0, separator + 1)}${protect(name, value)}`;
    })
    .join('&');
}

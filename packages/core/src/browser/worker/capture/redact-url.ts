/** Names of headers, fields and cookies whose values are credentials. */
export const SECRET_NAME =
  /authori[sz]ation|(?:^|[-_.])o?auth(?:$|[-_.])|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|(?:^|[-_.])t?otp(?:$|[-_.])|(?:^|[-_.])pin(?:$|[-_.])|(?:^|[-_.])code(?:$|[-_.])|(?:api|access|refresh)[-_.]?key|signature|(?:^|[-_.])sig(?:$|[-_.])/i;

/** A name with its camelCase words split by `_`, so `otpCode` is matched like `otp_code`. */
export function words(name: string) {
  return name.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
}

/** Whether a header, field or cookie name says its value is a credential. */
export function isSecretName(name: string) {
  return SECRET_NAME.test(words(name));
}

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

/** `decodeURIComponent`, or the text unchanged when it is malformed. */
export function decode(segment: string) {
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
    result.append(name, value && isSecretName(name) ? protect(name, value) : value);
  }

  return result;
}

/** Whether a URL fragment is a plain route or anchor: no `=` and no token-like part, after decoding. */
export function isPlainFragment(fragment: string): boolean {
  const decoded = decode(fragment);

  return !decoded.includes('=') && !decoded.split(/[/?&#;]/).some(looksLikeToken);
}

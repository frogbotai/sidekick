const NAMES = /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|intranet)$/i;

function v4(host: string) {
  const parts = host.split('.');

  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;

  const octets = parts.map(Number);

  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function privateV4([a = 0, b = 0, c = 0]: number[]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function groups(host: string) {
  const [head = '', tail, extra] = host.split('::');

  if (extra !== undefined) return undefined;

  const split = (part: string) => (part ? part.split(':') : []);
  const left = split(head);
  const right = tail === undefined ? [] : split(tail);
  const missing = 8 - left.length - right.length;

  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;

  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];

  if (!all.every((group) => /^[\da-f]{1,4}$/i.test(group))) return undefined;

  return all.map((group) => Number.parseInt(group, 16));
}

function embedded(words: number[]) {
  const [high = 0, low = 0] = words.slice(6);

  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function privateV6(words: number[]) {
  const [first = 0] = words;
  const zeros = (count: number) => words.slice(0, count).every((word) => word === 0);

  if (zeros(8)) return true;

  if (zeros(7) && words[7] === 1) return true;

  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return true;
  }

  const mapped = zeros(5) && words[5] === 0xffff;
  const compatible = zeros(6);
  const nat64 = first === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0);

  return (mapped || compatible || nat64) && privateV4(embedded(words));
}

/**
 * Why a URL's host is on this machine or a private network, or `undefined` for a public one:
 * `localhost` and local-only names (`*.local`, `*.internal`, dotless names), and IPv4 or IPv6
 * literals that are loopback, private, link-local, shared, multicast or reserved, IPv4 inside IPv6
 * included. The URL parser has already turned `2130706433` or `0x7f.1` into `127.0.0.1`. Names are
 * checked as written: the browser resolves them, and its answer isn't visible to an extension.
 */
export function privateHost(url: URL): string | undefined {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (host.startsWith('[')) {
    const words = groups(host.slice(1, -1));

    return !words || privateV6(words) ? `${host} is a local or private address` : undefined;
  }

  const octets = v4(host);

  if (octets) return privateV4(octets) ? `${host} is a local or private address` : undefined;

  if (NAMES.test(host)) return `${host} is a local network name`;

  return host.includes('.') ? undefined : `${host} is a local network name`;
}

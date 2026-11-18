/** How long a self-clearing check is waited out (D3). */
export const CHALLENGE_WAIT_MS = 15_000;

export const CHALLENGE_POLL_MS = 1_000;

export const PROBE_CAP_MS = 2_000;

const SHORT_PAGE = 1_500;

/** Vendor elements the content script looks for; `selectors` and `visibleSelectors` name the ones it found. */
export const PROBE_SELECTORS = [
  '#challenge-form',
  '#challenge-running',
  '#challenge-stage',
  '#cf-challenge-running',
  '.cf-turnstile',
  '#cf-error-details',
  '#sec-if-cpt-container',
  '#sec-cpt-if',
  '#sec-text-if',
  '#ddv1-captcha-container',
  '#px-captcha',
  '#px-captcha-wrapper',
  "[id^='px-captcha']",
  "#main-iframe[src*='_Incapsula_Resource']",
  '#captcha-container awswaf-captcha',
  'awswaf-captcha',
  '#challenge-container',
  '.g-recaptcha',
  "iframe[src*='/recaptcha/'][title*='challenge']",
  '.h-captcha',
];

/** The main frame as `page.probe` reads it. `text` is capped; `textLength` is not. */
export interface Probe {
  url: string;
  title: string;
  text: string;
  textLength: number;
  scriptSrcs: string[];
  selectors: string[];
  visibleSelectors: string[];
}

export type ChallengeKind = 'non-interactive' | 'interactive' | 'block';

export interface Detection {
  vendor: string;
  kind: ChallengeKind;
}

/** What an action reports when it ends on a captcha, bot check or block page. */
export interface Challenge extends Detection {
  status: 'cleared' | 'blocked';
  recommendation: 'continue' | 'handoff' | 'stop';
  message: string;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Classifies a probed page plus its frame URLs, or `null` when it isn't a challenge or block page.
 * Ported from browse (`rust/crates/browse-page/src/challenge.rs`), MIT License, Copyright (c) 2025
 * opencode; the notice is in
 * `packages/extension/public/THIRD_PARTY_NOTICES.md`, which ships in the extension.
 */
export function classify(probe: Probe & { frameUrls: string[] }): Detection | null {
  const title = probe.title.trim().toLowerCase();
  const text = probe.text.toLowerCase();
  const short = probe.textLength < SHORT_PAGE;
  const has = (selector: string) => probe.selectors.includes(selector);
  const visible = (selector: string) => probe.visibleSelectors.includes(selector);
  const frame = (pattern: RegExp) => probe.frameUrls.find((url) => pattern.test(url));
  const script = (pattern: RegExp) => probe.scriptSrcs.find((src) => pattern.test(src));
  const found = (vendor: string, kind: ChallengeKind): Detection => ({ vendor, kind });

  if (
    /sorry, you have been blocked/.test(text) &&
    (has('#cf-error-details') || text.includes('cloudflare'))
  ) {
    return found('cloudflare', 'block');
  }

  const interstitial =
    /^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment/.test(
      title,
    ) ||
    has('#challenge-form') ||
    has('#challenge-running') ||
    has('#cf-challenge-running') ||
    has('#challenge-stage');

  const turnstile = frame(
    /^https:\/\/challenges\.cloudflare\.com\/.*(turnstile|challenge-platform)/,
  );

  const asks =
    /verify you are human by completing|click to verify|confirm you are human|security check/.test(
      text,
    );

  const checking =
    /verifying you are human|checking (?:if the site connection is secure|your browser)/.test(text);

  if (interstitial || (turnstile && short && (asks || checking))) {
    const widget = visible('.cf-turnstile') || asks;

    return found('cloudflare', widget ? 'interactive' : 'non-interactive');
  }

  if (
    has('#px-captcha') ||
    has('#px-captcha-wrapper') ||
    has("[id^='px-captcha']") ||
    /press (?:&|and) hold/.test(text)
  ) {
    return found('perimeterx', 'interactive');
  }

  const datadome = frame(/captcha-delivery\.com/);

  if (datadome || has('#ddv1-captcha-container')) {
    return found(
      'datadome',
      datadome?.includes('/interstitial/') ? 'non-interactive' : 'interactive',
    );
  }

  if (has('#sec-if-cpt-container') || has('#sec-cpt-if') || has('#sec-text-if')) {
    const interactive = visible('#sec-cpt-if') && /verify|press|slide|captcha/.test(text);

    return found('akamai', interactive ? 'interactive' : 'non-interactive');
  }

  if (
    title === 'access denied' &&
    text.includes("you don't have permission to access") &&
    /reference #?\d/.test(text)
  ) {
    return found('akamai', 'block');
  }

  const incapsula = frame(/_Incapsula_Resource/) ?? script(/_Incapsula_Resource/);

  if (incapsula || has("#main-iframe[src*='_Incapsula_Resource']")) {
    const captcha =
      /captcha|verify you are human|i am human/.test(text) ||
      frame(/hcaptcha|recaptcha/) !== undefined;

    if (/request unsuccessful|incapsula incident id/.test(text) && !captcha) {
      return found('imperva', 'block');
    }

    return found('imperva', captcha ? 'interactive' : 'non-interactive');
  }

  if (text.includes('incapsula incident id') && short) return found('imperva', 'block');

  if (has('awswaf-captcha') || has('#captcha-container awswaf-captcha')) {
    return found('aws-waf', 'interactive');
  }

  if (
    script(/\.awswaf\.com\//) &&
    short &&
    (has('#challenge-container') || probe.textLength < 300)
  ) {
    return found('aws-waf', 'non-interactive');
  }

  if (!short) return null;

  const recaptcha = frame(
    /^https:\/\/www\.(?:google|recaptcha)\.(?:com|net)\/recaptcha\/(?:api2|enterprise)\/anchor(?!.*[?&]size=invisible)/,
  );

  const hcaptcha = frame(
    /^https:\/\/(?:newassets\.|assets\.)?hcaptcha\.com\/captcha\/(?!.*#.*-invisible)/,
  );

  const unnoticed = text.replace(/protected by (?:re|h)captcha/g, '');
  const wall =
    /verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha|captcha/.test(
      unnoticed,
    ) || /captcha|security check/.test(title);

  if (hcaptcha && wall) return found('hcaptcha', 'interactive');

  if (recaptcha && wall) return found('recaptcha', 'interactive');

  if (hostOf(probe.url).startsWith('www.google.') && probe.url.includes('/sorry/')) {
    return found('recaptcha', 'interactive');
  }

  if (
    /^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$/.test(
      title,
    ) ||
    /^(?:access to this page has been denied|access denied)\b/.test(text.trim())
  ) {
    return found('generic', 'block');
  }

  if (
    /verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|\bbot (?:check|detection)\b/.test(
      `${title}\n${text}`,
    )
  ) {
    return found('generic', 'interactive');
  }

  return null;
}

/** What the model is told; it names the site and the vendor but never quotes the page. */
export function warning(
  url: string,
  { vendor, kind }: Detection,
  status: Challenge['status'],
  waitedMs: number,
) {
  const origin = originOf(url);
  const seconds = Math.round(waitedMs / 1000);

  if (status === 'cleared') {
    return `A ${vendor} check on ${origin} cleared by itself after ${seconds} s. The page has loaded; carry on.`;
  }

  if (kind === 'block') {
    return `Blocked: ${origin} refused the visit (${vendor}). Don’t retry or reload in a loop, which makes the block worse for the person’s IP and account: stop, and tell the person.`;
  }

  const still = waitedMs > 0 ? `, still there after ${seconds} s` : '';

  return `Blocked by a ${vendor} ${kind} check on ${origin}${still}. Don’t retry, reload or try to solve it: stop and ask the person to solve it in this tab, then continue.`;
}

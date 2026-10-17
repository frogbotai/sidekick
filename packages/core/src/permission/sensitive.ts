import { siteOf } from '../tool/url';

/**
 * Sites where every panel call asks, in every mode, ignoring grants and without "Always", after
 * Claude for Chrome's forced prompts: sign-in, email, banking, payments, health and government.
 * Each host covers its subdomains.
 */
export const SENSITIVE_SITES: readonly string[] = [
  'accounts.google.com',
  'mail.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'outlook.live.com',
  'appleid.apple.com',
  'icloud.com',
  'mail.yahoo.com',
  'paypal.com',
  'stripe.com',
  'venmo.com',
  'wise.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'americanexpress.com',
  'mychart.org',
  'healthcare.gov',
  'login.gov',
  'irs.gov',
  'ssa.gov',
];

function hostOf(site: string) {
  return site.replace(/:\d+$/, '');
}

/** Whether `site` is `listed` or one of its subdomains; a listed port must match too. */
export function coversSite(listed: string, site: string) {
  const entry = siteOf(listed);

  if (/:\d+$/.test(entry)) return entry === site;

  const host = hostOf(site);

  return host === entry || host.endsWith(`.${entry}`);
}

export function isSensitive(site: string, list: readonly string[] = SENSITIVE_SITES) {
  return list.some((listed) => coversSite(listed, site));
}

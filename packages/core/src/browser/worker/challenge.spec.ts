import { describe, expect, it } from 'vitest';

import { classify, type Probe, warning } from './challenge';

type Page = Partial<Probe> & { frameUrls?: string[] };

function page({ text = '', ...rest }: Page = {}) {
  return {
    url: 'https://shop.example/',
    title: '',
    text,
    textLength: text.length,
    scriptSrcs: [],
    selectors: [],
    visibleSelectors: [],
    frameUrls: [],
    ...rest,
  };
}

const article = `verify you are human ${'lorem ipsum '.repeat(200)}`;

describe('classify (req. 2, 3, 12)', () => {
  it.each<[string, Page, string, string]>([
    [
      'Cloudflare interstitial',
      { title: 'Just a moment...', text: 'Checking your browser' },
      'cloudflare',
      'non-interactive',
    ],
    [
      'Cloudflare Turnstile iframe',
      {
        text: 'Verify you are human by completing the action below.',
        frameUrls: [
          'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2',
        ],
      },
      'cloudflare',
      'interactive',
    ],
    [
      'Cloudflare block',
      {
        title: 'Attention',
        text: 'Sorry, you have been blocked. Cloudflare Ray ID',
        selectors: ['#cf-error-details'],
      },
      'cloudflare',
      'block',
    ],
    [
      'PerimeterX',
      { text: 'Press & Hold to confirm you are a human' },
      'perimeterx',
      'interactive',
    ],
    [
      'DataDome',
      { frameUrls: ['https://geo.captcha-delivery.com/captcha/?initialCid=x'] },
      'datadome',
      'interactive',
    ],
    [
      'DataDome interstitial',
      { frameUrls: ['https://geo.captcha-delivery.com/interstitial/?initialCid=x'] },
      'datadome',
      'non-interactive',
    ],
    ['Akamai sensor', { selectors: ['#sec-if-cpt-container'] }, 'akamai', 'non-interactive'],
    [
      'Akamai block',
      {
        title: 'Access Denied',
        text: "You don't have permission to access this server. Reference #18.2b",
      },
      'akamai',
      'block',
    ],
    [
      'Imperva',
      {
        scriptSrcs: ['https://shop.example/_Incapsula_Resource?SWJIYLWA=1'],
        text: 'Request unsuccessful. Incapsula incident ID: 1',
      },
      'imperva',
      'block',
    ],
    ['AWS WAF', { selectors: ['awswaf-captcha'] }, 'aws-waf', 'interactive'],
    [
      'reCAPTCHA wall',
      {
        text: 'Please complete the captcha to continue',
        frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=x'],
      },
      'recaptcha',
      'interactive',
    ],
    [
      'hCaptcha wall',
      {
        title: 'Security check',
        frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'],
      },
      'hcaptcha',
      'interactive',
    ],
    [
      'google.com/sorry',
      { url: 'https://www.google.com/sorry/index', text: 'unusual traffic' },
      'recaptcha',
      'interactive',
    ],
    ['generic block', { title: 'Access Denied', text: 'Access denied' }, 'generic', 'block'],
    [
      'generic verification',
      { title: 'Check', text: 'Please verify you are a human' },
      'generic',
      'interactive',
    ],
  ])('%s', (_name, input, vendor, kind) => {
    expect(classify(page(input))).toEqual({ vendor, kind });
  });

  it.each<[string, Page]>([
    ['a long article that says “verify you are human”', { title: 'News', text: article }],
    [
      'a short login page titled “Verify your email”',
      { title: 'Verify your email', text: 'We sent a code to you@example.com. Enter it below.' },
    ],
    [
      'a search results page',
      { title: 'captcha - Search', text: `Results for captcha ${'result '.repeat(300)}` },
    ],
    ['an empty page', {}],
    [
      'a long page with a reCAPTCHA on its signup form',
      { text: article, frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=x'] },
    ],
  ])('%s is not a wall', (_name, input) => {
    expect(classify(page(input))).toBeNull();
  });
});

describe('warning (req. 10, 11)', () => {
  it('names the origin, says not to retry, and asks the person', () => {
    const text = warning(
      'https://a.example/x?y',
      { vendor: 'cloudflare', kind: 'interactive' },
      'blocked',
      0,
    );

    expect(text).toContain('on https://a.example.');
    expect(text).toContain('Don’t retry, reload or try to solve it');
    expect(text).toContain('ask the person to solve it in this tab');
  });

  it('says retrying makes a block worse', () => {
    expect(
      warning('https://a.example/', { vendor: 'generic', kind: 'block' }, 'blocked', 0),
    ).toContain('makes the block worse for the person’s IP');
  });

  it('says how long a check stayed', () => {
    expect(
      warning(
        'https://a.example/',
        { vendor: 'cloudflare', kind: 'non-interactive' },
        'blocked',
        15_000,
      ),
    ).toContain('still there after 15 s');
  });
});

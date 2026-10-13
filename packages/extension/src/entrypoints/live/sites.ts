import type { OutlineItem } from './outline';

export interface Site {
  id: string;
  name: string;
  url: string;
  /** Needs the owner signed in, so it starts unticked. */
  signIn?: boolean;
  /** Best effort: its failures don't count against the ticket. */
  optional?: boolean;
  /** The field to click and fill, from the page snapshot's refs. */
  field: (items: OutlineItem[]) => OutlineItem | undefined;
  /** An editor: the fill replaces the demo text and stays, so the owner can see it. */
  editor?: boolean;
  /** Also tests `navigate` to this URL, then back and forward. */
  navigateTo?: string;
  /** Also tests `select` on a `<select>` with this name, choosing this option. */
  select?: { name: RegExp; value: string };
  note: string;
  questions: { id: string; text: string }[];
}

export const TEXT_ROLES = ['searchbox', 'textbox', 'combobox'];

const searchField = (name: RegExp) => (items: OutlineItem[]) =>
  items
    .filter((item) => TEXT_ROLES.includes(item.role) && name.test(item.name))
    .sort((a, b) => TEXT_ROLES.indexOf(a.role) - TEXT_ROLES.indexOf(b.role))[0];

const editorField = (items: OutlineItem[]) =>
  items
    .filter((item) => item.role === 'textbox')
    .reduce<OutlineItem | undefined>(
      (best, item) => ((item.value ?? '').length > (best?.value ?? '').length ? item : best),
      undefined,
    );

export const FILL_TEXT = 'sidekick test';

export const SITES: Site[] = [
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://github.com/cli/cli/issues',
    field: searchField(/search|filter/i),
    note: 'types into the issue search box and erases it; never presses Enter',
    questions: [
      {
        id: 'github-ok',
        text: 'Did GitHub look normal throughout (no warning, sign-out or error page)?',
      },
    ],
  },
  {
    id: 'mdn',
    name: 'MDN (cross-origin live example)',
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/text',
    field: (items) => items.find((item) => item.frame !== 0 && TEXT_ROLES.includes(item.role)),
    navigateTo: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input',
    note: 'the field lives in a cross-origin iframe; also goes to another MDN page and back',
    questions: [
      {
        id: 'mdn-ok',
        text: 'Did MDN look normal throughout (no warning or error page)?',
      },
    ],
  },
  {
    id: 'lexical',
    name: 'Lexical playground',
    url: 'https://playground.lexical.dev/',
    field: editorField,
    editor: true,
    note: 'replaces the demo text with “sidekick test”; nothing is saved',
    questions: [
      {
        id: 'lexical-text',
        text: 'Click the Lexical tab in the Sidekick live test group. Does its editor show only “sidekick test” (the demo text gone)?',
      },
    ],
  },
  {
    id: 'prosemirror',
    name: 'ProseMirror demo',
    url: 'https://prosemirror.net/examples/basic/',
    field: editorField,
    editor: true,
    note: 'replaces the demo text with “sidekick test”; nothing is saved',
    questions: [
      {
        id: 'prosemirror-text',
        text: 'Click the ProseMirror tab in the same group. Does its editor show only “sidekick test”?',
      },
    ],
  },
  {
    id: 'amazon',
    name: 'Amazon',
    url: 'https://www.amazon.com/s?k=usb+c+cable',
    optional: true,
    field: searchField(/search/i),
    select: { name: /search in|department|categor/i, value: 'Books' },
    note: 'best effort: types into the search box and erases it; never presses Enter',
    questions: [
      {
        id: 'amazon-ok',
        text: 'Did Amazon look normal throughout (no “verify you’re human” page, warning or error)?',
      },
    ],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    signIn: true,
    field: searchField(/search/i),
    note: 'uses the search box only; never opens compose',
    questions: [
      {
        id: 'gmail-ok',
        text: 'Did Gmail look normal throughout (no warning or sign-out)?',
      },
    ],
  },
];

/** Where e2e points each site instead: `{ github: { url, navigateTo? } }` in `storage.local`. */
export const OVERRIDES_KEY = 'liveSiteOverrides';

export function applyOverrides(overrides: unknown) {
  if (typeof overrides !== 'object' || overrides === null) return;

  for (const site of SITES) {
    const override: unknown = Reflect.get(overrides, site.id);

    if (typeof override !== 'object' || override === null) continue;

    const url: unknown = Reflect.get(override, 'url');
    const navigateTo: unknown = Reflect.get(override, 'navigateTo');

    if (typeof url === 'string') site.url = url;

    if (typeof navigateTo === 'string') site.navigateTo = navigateTo;
  }
}

export const GLOBAL_QUESTIONS = [
  {
    id: 'bar',
    text: 'Did a bar saying “Sidekick live test (ticket 271)” started debugging this browser appear at the top of the window?',
  },
  {
    id: 'barSteady',
    text: 'Once it appeared, did that bar stay put while a site was being tested, rather than flashing on and off between steps?',
  },
  {
    id: 'indicator',
    text: 'Did you see a green glow around the page, a green arrow cursor and a red “Stop Sidekick” button while a site was being tested?',
  },
  {
    id: 'indicatorGone',
    text: 'After you clicked “Stop Sidekick”, did the glow and the button go away?',
  },
  {
    id: 'sideEffects',
    text: 'Did anything get posted, sent, saved or deleted that you did not expect?',
  },
];

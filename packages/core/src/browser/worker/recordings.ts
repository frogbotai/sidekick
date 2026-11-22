import type { RecordedStep } from '../../protocol';
import type { Page, Tabs } from './types';

/** A step of a demonstration: what a frame recorded, or a new document in the tab. */
export type DemonstrationStep = RecordedStep | { kind: 'navigation'; url: string };

interface Entry {
  frameId?: number;
  step: DemonstrationStep;
}

interface Recording {
  id: number;
  entries: Entry[];
  secret: Set<string>;
  masked: Map<string, string>;
}

const LOAD_TIMEOUT_MS = 10_000;

const MAX_STEPS = 500;

export interface Recordings {
  /**
   * Starts recording a tab in every frame, and in every document it loads until `stop`. A new
   * recording on the tab sets the earlier one aside, so its `stop` with its id still gets its steps.
   */
  start(tabId: number): Promise<number>;
  recording(tabId: number): boolean;
  /**
   * A frame's step; a fill of the field the last step filled replaces it. A fill of a field that
   * was redacted or masked earlier in the recording stays so. Urls keep no query or fragment.
   */
  step(tabId: number, frameId: number, step: RecordedStep): void;
  /** Ends the tab's recording, or with `id` the recording `start` returned it for, and gives its steps. */
  stop(tabId: number, id?: number): Promise<DemonstrationStep[]>;
  dispose(): void;
}

/** A url without credentials, query or fragment, where a GET form puts the values typed into it. */
export function bareUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';

    return parsed.href;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function hidden(
  { kind, frameUrl, role, name, nearby, selector }: RecordedStep,
  privacy: { redacted: true } | { masked: string },
): RecordedStep {
  return { kind, frameUrl, role, name, nearby, selector, ...privacy };
}

function sticky(recording: Recording, frameId: number | undefined, step: RecordedStep) {
  if (step.kind !== 'fill') return step;

  const key = `${frameId ?? ''} ${step.selector}`;

  if (step.redacted) recording.secret.add(key);

  if (step.masked) recording.masked.set(key, step.masked);

  if (recording.secret.has(key)) return step.redacted ? step : hidden(step, { redacted: true });

  const masked = recording.masked.get(key);

  return masked && !step.masked ? hidden(step, { masked }) : step;
}

function bare(step: DemonstrationStep): DemonstrationStep {
  return step.kind === 'navigation'
    ? { ...step, url: bareUrl(step.url) }
    : { ...step, frameUrl: bareUrl(step.frameUrl) };
}

/** One recording per tab for `demonstrate` (sidekick-21), after browse's demonstration recorder. */
export function createRecordings({ page, tabs }: { page: Page; tabs: Tabs }): Recordings {
  const active = new Map<number, Recording>();
  const aside = new Map<number, Entry[]>();
  let next = 0;

  const off = (tabId: number) => page.record(tabId, false).catch(() => undefined);

  const arm = async (tabId: number) => {
    if (!active.has(tabId)) return;

    await page.record(tabId, true).catch(() => undefined);

    if (!active.has(tabId)) await off(tabId);
  };

  const add = (tabId: number, entry: Entry) => {
    const recording = active.get(tabId);

    if (!recording) return;

    const { entries } = recording;
    const last = entries.at(-1);
    const bared = bare(entry.step);
    const step = bared.kind === 'navigation' ? bared : sticky(recording, entry.frameId, bared);

    if (
      step.kind === 'fill' &&
      last?.step.kind === 'fill' &&
      last.frameId === entry.frameId &&
      last.step.selector === step.selector
    ) {
      entries[entries.length - 1] = { frameId: entry.frameId, step };
    } else if (entries.length < MAX_STEPS) {
      entries.push({ frameId: entry.frameId, step });
    }
  };

  const stopCommits = tabs.onCommitted(({ tabId, url, sameDocument }) => {
    if (sameDocument || !active.has(tabId)) return;

    add(tabId, { step: { kind: 'navigation', url } });
    void arm(tabId);

    void tabs
      .waitForLoad(tabId, LOAD_TIMEOUT_MS)
      .then(() => arm(tabId))
      .catch(() => undefined);
  });

  return {
    start: async (tabId) => {
      const earlier = active.get(tabId);
      const id = ++next;

      if (earlier) aside.set(earlier.id, earlier.entries);

      active.set(tabId, { id, entries: [], secret: new Set(), masked: new Map() });
      await arm(tabId);

      return id;
    },
    recording: (tabId) => active.has(tabId),
    step: (tabId, frameId, step) => add(tabId, { frameId, step }),
    stop: async (tabId, id) => {
      const recording = active.get(tabId);

      if (id !== undefined && recording?.id !== id) {
        const entries = aside.get(id) ?? [];

        aside.delete(id);

        return entries.map(({ step }) => step);
      }

      active.delete(tabId);
      await off(tabId);

      return (recording?.entries ?? []).map(({ step }) => step);
    },
    dispose: () => {
      stopCommits();

      for (const tabId of active.keys()) void off(tabId);

      active.clear();
      aside.clear();
    },
  };
}

const ROLE_WORDS: Record<string, string> = {
  menuitem: 'menu item',
  menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item',
  treeitem: 'tree item',
  searchbox: 'search box',
  textbox: 'text box',
  combobox: 'list',
};

function roleWord(role: string) {
  return ROLE_WORDS[role] ?? (role || 'element');
}

function flat(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function target(step: RecordedStep) {
  return step.name ? `"${flat(step.name)}"` : `the ${roleWord(step.role)}`;
}

function maskedWords(token: string) {
  return `your ${token.replace(/-/g, ' ')}`;
}

function shortUrl(url: string) {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function fillLine(step: RecordedStep) {
  if (step.redacted) return `Typed a secret into ${target(step)}`;

  if (step.masked) return `Typed ${maskedWords(step.masked)} into ${target(step)}`;

  const value = flat(step.value ?? '');

  return value ? `Typed "${value}" into ${target(step)}` : `Cleared ${target(step)}`;
}

function selectLine(step: RecordedStep) {
  if (step.redacted) return `Chose a hidden option in ${target(step)}`;

  if (step.masked) return `Chose ${maskedWords(step.masked)} in ${target(step)}`;

  const options = (step.options ?? []).map((option) => `"${flat(option)}"`).join(', ');

  return options ? `Chose ${options} in ${target(step)}` : `Cleared ${target(step)}`;
}

/** One plain line per step, as browse's `describe_step` writes them. */
export function describeStep(step: DemonstrationStep): string {
  switch (step.kind) {
    case 'navigation':
      return `Went to ${shortUrl(flat(step.url))}`;
    case 'click':
      return step.name
        ? `Clicked the "${flat(step.name)}" ${roleWord(step.role)}`
        : `Clicked a ${roleWord(step.role)}`;
    case 'fill':
      return fillLine(step);
    case 'check':
      if (step.role === 'radio') return `Chose ${target(step)}`;

      return `${step.checked ? 'Checked' : 'Unchecked'} ${target(step)}`;
    case 'select':
      return selectLine(step);
    case 'file':
      return `Chose a file for ${target(step)}; which file wasn't recorded`;
  }
}

/** The steps as a numbered list, one line each. */
export function summarize(steps: DemonstrationStep[]): string {
  return steps.map((step, index) => `${index + 1}. ${describeStep(step)}`).join('\n');
}

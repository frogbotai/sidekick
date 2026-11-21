import type { RecordedStep } from '../../protocol';
import type { Page, Tabs } from './types';

/** A step of a demonstration: what a frame recorded, or a new document in the tab. */
export type DemonstrationStep = RecordedStep | { kind: 'navigation'; url: string };

interface Entry {
  frameId?: number;
  step: DemonstrationStep;
}

interface Recording {
  entries: Entry[];
  secret: Set<string>;
}

const LOAD_TIMEOUT_MS = 10_000;

const MAX_STEPS = 500;

export interface Recordings {
  /** Starts recording a tab in every frame, and in every document it loads until `stop`. */
  start(tabId: number): Promise<void>;
  recording(tabId: number): boolean;
  /**
   * A frame's step; a fill of the field the last step filled replaces it. A fill of a field that
   * was redacted earlier in the recording stays redacted.
   */
  step(tabId: number, frameId: number, step: RecordedStep): void;
  stop(tabId: number): Promise<DemonstrationStep[]>;
  dispose(): void;
}

function redact({ kind, frameUrl, role, name, nearby, selector }: RecordedStep): RecordedStep {
  return { kind, frameUrl, role, name, nearby, selector, redacted: true };
}

function sticky(recording: Recording, frameId: number | undefined, step: DemonstrationStep) {
  if (step.kind !== 'fill') return step;

  const key = `${frameId ?? ''} ${step.selector}`;

  if (step.redacted) recording.secret.add(key);

  return recording.secret.has(key) && !step.redacted ? redact(step) : step;
}

/** One recording per tab for `demonstrate` (sidekick-21), after browse's demonstration recorder. */
export function createRecordings({ page, tabs }: { page: Page; tabs: Tabs }): Recordings {
  const active = new Map<number, Recording>();

  const arm = (tabId: number) =>
    active.has(tabId) ? page.record(tabId, true).catch(() => undefined) : Promise.resolve();

  const add = (tabId: number, entry: Entry) => {
    const recording = active.get(tabId);

    if (!recording) return;

    const { entries } = recording;
    const last = entries.at(-1);
    const step = sticky(recording, entry.frameId, entry.step);

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
      active.set(tabId, { entries: [], secret: new Set() });
      await arm(tabId);
    },
    recording: (tabId) => active.has(tabId),
    step: (tabId, frameId, step) => add(tabId, { frameId, step }),
    stop: async (tabId) => {
      const entries = active.get(tabId)?.entries ?? [];

      active.delete(tabId);
      await page.record(tabId, false).catch(() => undefined);

      return entries.map(({ step }) => step);
    },
    dispose: () => {
      stopCommits();
      active.clear();
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
  }
}

/** The steps as a numbered list, one line each. */
export function summarize(steps: DemonstrationStep[]): string {
  return steps.map((step, index) => `${index + 1}. ${describeStep(step)}`).join('\n');
}

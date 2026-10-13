import type { TestReply, TestRequest } from '../../testTools';
import { SITES } from './sites';

export type Status = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Step {
  id: string;
  label: string;
  status: Status;
  detail: string;
  ms?: number;
}

export interface Numbers {
  chars: number;
  tokens: number;
  refs: number;
  frames: number;
  ms: number;
  redacted: number;
  stable?: number;
  pageChars?: number;
  pageTruncated?: boolean;
  /** Frames with refs in the page snapshot. */
  pageFrames?: number;
  iframes?: number;
  unreadable?: number;
}

export interface SiteRun {
  id: string;
  status: Status;
  reason: string;
  tabId?: number;
  steps: Step[];
  numbers?: Numbers;
}

export interface LiveState {
  chrome: string;
  startedAt?: number;
  finishedAt?: number;
  sites: SiteRun[];
  run: Step[];
  events: string[];
  answers: Record<string, 'Yes' | 'No'>;
  notes: string;
  log: string[];
  /** The owner should click Stop Sidekick on the page now. */
  awaitingStop: boolean;
  /** The run's tab group. */
  groupId?: number;
}

const SITE_STEPS: [string, string][] = [
  ['open', 'Open'],
  ['snapshot', 'Snapshot'],
  ['refs', 'Refs stable'],
  ['page', 'Page snapshot'],
  ['scroll', 'Scroll'],
  ['scroll_to', 'Scroll to'],
  ['hover', 'Hover'],
  ['click', 'Click'],
  ['fill', 'Fill'],
  ['readback', 'Read back'],
  ['clear', 'Clear'],
  ['press', 'Press'],
  ['select', 'Select'],
  ['navigate', 'Navigate'],
  ['screenshot', 'Screenshot'],
  ['background', 'Background shot'],
];

const RUN_STEPS: [string, string][] = [
  ['start', 'Start run'],
  ['tabs_list', 'tabs_list'],
  ['tabs_switch', 'tabs_switch'],
  ['tabs_close', 'tabs_close'],
  ['stop', 'Stop button'],
  ['stopped', 'After Stop'],
  ['group', 'Group after Stop'],
];

export const STEP_LABELS = Object.fromEntries([...SITE_STEPS, ...RUN_STEPS]);

export const SITE_STEP_IDS = SITE_STEPS.map(([id]) => id);

function steps(list: [string, string][]): Step[] {
  return list.map(([id, label]) => ({ id, label, status: 'pending', detail: '' }));
}

export function freshState(): LiveState {
  return {
    chrome: /Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? navigator.userAgent,
    sites: SITES.map((site) => ({
      id: site.id,
      status: 'pending',
      reason: '',
      steps: steps(SITE_STEPS),
    })),
    run: steps(RUN_STEPS),
    events: [],
    answers: {},
    notes: '',
    log: [],
    awaitingStop: false,
  };
}

export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`${code}: ${message}`);
  }
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function send(request: TestRequest): Promise<TestReply> {
  return chrome.runtime.sendMessage(request);
}

export async function brightness(uri: string) {
  const bitmap = await createImageBitmap(await (await fetch(uri)).blob());
  const canvas = new OffscreenCanvas(32, 32);
  const draw = canvas.getContext('2d');

  if (!draw) return -1;

  draw.drawImage(bitmap, 0, 0, 32, 32);

  const { data } = draw.getImageData(0, 0, 32, 32);
  let sum = 0;

  for (let index = 0; index < data.length; index += 4) {
    sum += ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0)) / 3;
  }

  return Math.round(sum / (data.length / 4));
}

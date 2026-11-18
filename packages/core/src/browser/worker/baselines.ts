import { ToolError } from '../../tool/tool';
import type { Run } from './runs';
import type { Capture } from './types';

/** A named screenshot and how it was taken, so `screenshot_diff` can capture the same way. */
export interface Baseline {
  tabId: number;
  scale: number;
  ref?: string;
  capture: Capture;
}

export const MAX_BASELINES = 20;

const byRun = new WeakMap<Run, Map<string, Baseline>>();

/** Keeps `baseline` under `name` for the run, replacing an older one and dropping the oldest past the cap. */
export function keepBaseline(run: Run, name: string, baseline: Baseline) {
  const baselines = byRun.get(run) ?? new Map<string, Baseline>();

  baselines.delete(name);
  baselines.set(name, baseline);

  for (const oldest of baselines.keys()) {
    if (baselines.size <= MAX_BASELINES) break;

    baselines.delete(oldest);
  }

  byRun.set(run, baselines);
}

export function baselineOf(run: Run, name: string, tabId: number): Baseline {
  const baseline = byRun.get(run)?.get(name);

  if (!baseline) {
    throw new ToolError(
      'no_baseline',
      `No baseline named “${name}” in this task. Take one with screenshot and name “${name}”, then diff. Baselines last only while Sidekick runs, and only the last ${MAX_BASELINES} are kept.`,
    );
  }

  if (baseline.tabId !== tabId) {
    throw new ToolError(
      'no_baseline',
      `Baseline “${name}” was taken on tab ${baseline.tabId}. Diff that tab, or take a new baseline on tab ${tabId}.`,
    );
  }

  return baseline;
}

import { connectWorker, sidekickProtocol } from '@frogbotai/sidekick-core';

import { groupMembers, maxLengthOf, pause, subframesReported, textFields } from './checks';
import { iframes, outline, type OutlineItem, stability, tokens } from './outline';
import { FILL_TEXT, type Site, SITES } from './sites';
import {
  brightness,
  errorText,
  type LiveState,
  send,
  type SiteRun,
  type Step,
  ToolFailure,
} from './state';

interface Snapshot {
  url: string;
  title: string;
  snapshot: string;
  redacted: number;
  truncated: boolean;
}

const CALL_TIMEOUT_MS = 90_000;

const STOP_WAIT_MS = 90_000;

const ATTEMPTS = 4;

const RETRY_FIELD_MS = 2_000;

/** Runs every step against the real tools in the worker and records what happened. */
export class LiveRunner {
  private runId = '';
  private stopped = false;
  private readonly worker = connectWorker(sidekickProtocol);

  constructor(
    private readonly state: LiveState,
    private readonly changed: () => void,
  ) {
    this.worker.on('page.stripped', ({ tabId, removed }) =>
      this.event(`page.stripped: tab ${tabId} lost ${removed.join(', ')}`),
    );

    this.worker.on('run.stopped', ({ runId, reason }) => {
      if (runId === this.runId) this.event(`run.stopped: ${reason}`);
    });
  }

  private log(line: string) {
    this.state.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    this.changed();
  }

  private event(line: string) {
    this.state.events.push(line);
    this.log(line);
  }

  /** The panel's Stop: ends the run and skips what is left. */
  stop() {
    this.stopped = true;
    this.log('Stop pressed in the panel');

    if (this.runId) void this.worker.call('run.stop', { runId: this.runId }).catch(() => undefined);
  }

  private async call<T>(tool: string, input: Record<string, unknown> = {}) {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolFailure('runner_timeout', `${tool} took over 90 s`)),
        CALL_TIMEOUT_MS,
      );
    });

    try {
      const reply = await Promise.race([
        send({ sidekickTest: 'call', runId: this.runId, tool, input }),
        timeout,
      ]);

      const ms = Math.round(performance.now() - started);

      if ('error' in reply) {
        this.log(`${tool} ✗ ${reply.error.code} (${ms} ms)`);

        throw new ToolFailure(reply.error.code, reply.error.message, reply.error.detail);
      }

      this.log(`${tool} ✓ (${ms} ms)`);

      return { output: reply.ok as T, content: reply.content ?? [], ms };
    } finally {
      clearTimeout(timer);
    }
  }

  private async step(steps: Step[], id: string, work: () => Promise<string>) {
    const step = steps.find((entry) => entry.id === id);

    if (!step) return false;

    if (this.stopped) {
      Object.assign(step, { status: 'skipped', detail: 'stopped' });

      return false;
    }

    step.status = 'running';
    this.changed();

    const started = performance.now();

    try {
      step.detail = await work();
      step.status = 'passed';
    } catch (error) {
      step.detail = errorText(error);
      step.status = 'failed';
    }

    step.ms = Math.round(performance.now() - started);
    this.changed();

    return step.status === 'passed';
  }

  /** Tries up to `ATTEMPTS` elements, since some links and buttons are hidden on purpose. */
  private async attempts(
    steps: Step[],
    id: string,
    targets: OutlineItem[],
    work: (item: OutlineItem) => Promise<void>,
  ) {
    if (targets.length === 0) return this.skip(steps, id, 'no link or button to try');

    await this.step(steps, id, async () => {
      const misses: string[] = [];

      for (const item of targets) {
        try {
          await work(item);

          const tried = misses.length > 0 ? ` (after ${misses.join('; ')})` : '';

          return `${item.role} "${item.name.slice(0, 40)}" ${item.ref}${tried}`;
        } catch (error) {
          misses.push(`${item.ref} ${errorText(error).slice(0, 60)}`);
        }
      }

      throw new Error(misses.join('; '));
    });
  }

  private skip(steps: Step[], id: string, detail: string) {
    const step = steps.find((entry) => entry.id === id);

    if (step) Object.assign(step, { status: 'skipped', detail });
  }

  private skipRest(steps: Step[], detail: string) {
    for (const step of steps) {
      if (step.status === 'pending' || step.status === 'running') {
        Object.assign(step, { status: 'skipped', detail });
      }
    }
  }

  async run(selected: Set<string>) {
    this.state.startedAt = Date.now();

    const sites = SITES.filter((site) => selected.has(site.id));

    for (const site of SITES) {
      const run = this.siteRun(site.id);

      if (!selected.has(site.id)) {
        Object.assign(run, { status: 'skipped', reason: 'not ticked' });
        this.skipRest(run.steps, 'not ticked');
      }
    }

    let startTab: number | undefined;

    const started = await this.step(this.state.run, 'start', async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });

      if (tab.id === undefined) throw new Error('Chrome gave the new tab no id');

      startTab = tab.id;

      const { runId, groupId } = await this.worker.call('run.start', {
        tabId: tab.id,
        label: 'Sidekick live test',
      });

      this.runId = runId;
      this.state.groupId = groupId;

      return `run ${runId.slice(0, 8)}, group ${groupId}`;
    });

    if (!started || startTab === undefined) {
      this.skipRest(this.state.run, 'the run did not start');

      for (const site of this.state.sites) this.skipRest(site.steps, 'the run did not start');

      return this.finish();
    }

    for (const [index, site] of sites.entries()) {
      await this.site(site, index === 0 ? startTab : undefined);
    }

    await this.wrapUp(sites);

    return this.finish();
  }

  private finish() {
    this.state.finishedAt = Date.now();
    this.state.awaitingStop = false;
    this.changed();
  }

  private siteRun(id: string) {
    const run = this.state.sites.find((entry) => entry.id === id);

    if (!run) throw new Error(`No slot for ${id}`);

    return run;
  }

  private async site(site: Site, startTab: number | undefined) {
    const run = this.siteRun(site.id);
    const { steps: list } = run;

    run.status = 'running';
    this.log(`— ${site.name}`);

    const opened = await this.step(list, 'open', async () => {
      if (startTab !== undefined) {
        const { output } = await this.call<{ url: string; settled: boolean }>('navigate', {
          tab_id: startTab,
          url: site.url,
        });

        run.tabId = startTab;

        return `navigate → ${output.url}${output.settled ? '' : ' (not settled)'}`;
      }

      const { output } = await this.call<{ tab_id: number; url: string; settled: boolean }>(
        'tabs_open',
        { url: site.url, focus: true },
      );

      run.tabId = output.tab_id;

      return `tabs_open → ${output.url}${output.settled ? '' : ' (not settled)'}`;
    });

    const tabId = run.tabId;

    if (!opened || tabId === undefined) {
      this.skipRest(list, 'the site did not open');
      run.status = 'failed';
      run.reason = 'did not open';

      return;
    }

    await this.siteSteps(site, run, tabId);

    run.status = list.some((step) => step.status === 'failed') ? 'failed' : 'passed';
    this.changed();
  }

  private async siteSteps(site: Site, run: SiteRun, tabId: number) {
    const { steps: list } = run;
    let items: OutlineItem[] = [];
    let page: OutlineItem[] = [];
    let field: OutlineItem | undefined;

    await this.step(list, 'snapshot', async () => {
      const { output, ms } = await this.call<Snapshot>('snapshot', { tab_id: tabId });

      items = outline(output.snapshot);

      run.numbers = {
        chars: output.snapshot.length,
        tokens: tokens(output.snapshot),
        refs: items.length,
        frames: new Set(items.map((item) => item.frame)).size,
        ms,
        redacted: output.redacted,
      };

      return `${items.length} refs, ≈${run.numbers.tokens} tokens, ${run.numbers.frames} frame(s) with refs, ${output.redacted} redacted${output.truncated ? ', truncated' : ''}`;
    });

    await this.step(list, 'refs', async () => {
      const { output } = await this.call<Snapshot>('snapshot', { tab_id: tabId });
      const share = stability(items, outline(output.snapshot));

      if (run.numbers) run.numbers.stable = share;

      if (share < 0.95) throw new Error(`only ${Math.round(share * 100)}% of refs kept`);

      return `${Math.round(share * 100)}% of refs kept`;
    });

    await this.step(list, 'page', async () => {
      const read = async () => {
        const { output } = await this.call<Snapshot>('snapshot', { tab_id: tabId, scope: 'page' });

        page = outline(output.snapshot);
        field = site.field(page) ?? site.field(items);

        return output;
      };

      let output = await read();
      let again = '';

      if (!field) {
        await pause(RETRY_FIELD_MS);
        output = await read();
        again = field ? ' (on a second snapshot, 2 s later)' : '';
      }

      const frames = iframes(output.snapshot);
      const reported = await subframesReported(tabId);

      if (run.numbers) {
        run.numbers.pageChars = output.snapshot.length;
        run.numbers.pageTruncated = output.truncated;
        run.numbers.pageFrames = new Set(page.map((item) => item.frame)).size;
        run.numbers.iframes = frames.all;
        run.numbers.unreadable = frames.unreadable;
      }

      return `${page.length} refs, ≈${tokens(output.snapshot)} tokens${output.truncated ? ', truncated at 30,000 chars' : ''}, ${frames.all} iframe(s), ${frames.unreadable} not readable, ${reported} subframe(s) in webNavigation; field: ${field ? `${field.role} "${field.name}" ${field.ref}${again}${field.role === 'combobox' ? textFields(page) : ''}` : `none found${textFields(page)}`}`;
    });

    await this.step(list, 'scroll', async () => {
      type Scrolled = { moved: number; container: string; at_end: boolean };

      const down = await this.call<Scrolled>('scroll', { tab_id: tabId, direction: 'down' });
      const up = await this.call<Scrolled>('scroll', {
        tab_id: tabId,
        direction: 'up',
        amount: Math.max(1, down.output.moved),
      });

      if (down.output.moved === 0) {
        throw new Error(`nothing moved (container ${down.output.container})`);
      }

      return `down ${down.output.moved} px in ${down.output.container}${down.output.at_end ? ' (end)' : ''}, up ${up.output.moved} px`;
    });

    const far = [...page]
      .reverse()
      .filter((item) => item.role === 'link' || item.role === 'button')
      .slice(0, ATTEMPTS);

    await this.attempts(list, 'scroll_to', far, async (item) => {
      const { output } = await this.call<{ in_view: boolean; obscured_by?: string }>('scroll_to', {
        tab_id: tabId,
        ref: item.ref,
      });

      if (!output.in_view) throw new Error(`covered by ${output.obscured_by ?? '?'}`);
    });

    const links = items.filter((item) => item.role === 'link').slice(0, ATTEMPTS);

    await this.attempts(list, 'hover', links, async (item) => {
      await this.call('hover', { tab_id: tabId, ref: item.ref });
    });

    await this.fieldSteps(site, run, tabId, field, page);
    await this.extraSteps(site, run, tabId, page);

    await this.step(list, 'screenshot', async () => {
      const { output, content } = await this.call<{ width: number; height: number }>('screenshot', {
        tab_id: tabId,
        scale: 0.5,
      });

      const image = content.find((item) => item.type === 'file');
      const light = image?.type === 'file' ? await brightness(image.uri) : -1;

      return `${output.width}×${output.height}, brightness ${light}`;
    });
  }

  private async fieldSteps(
    site: Site,
    run: SiteRun,
    tabId: number,
    picked: OutlineItem | undefined,
    page: OutlineItem[],
  ) {
    const { steps: list } = run;

    if (!picked) {
      for (const id of ['click', 'fill', 'readback', 'clear', 'press']) {
        this.skip(list, id, 'no field found in the snapshot');
      }

      return;
    }

    let field = picked;

    await this.step(list, 'click', async () => {
      const { output } = await this.call<{ navigated: boolean }>('click', {
        tab_id: tabId,
        ref: field.ref,
      });

      if (output.navigated) throw new Error('the click navigated');

      return `${field.role} "${field.name.slice(0, 40)}" ${field.ref}`;
    });

    let text = FILL_TEXT;

    const fillAt = async (target: OutlineItem) => {
      try {
        await this.call('fill', { tab_id: tabId, ref: target.ref, text });

        return `“${text}” in ${target.ref} by fill`;
      } catch (error) {
        const max = maxLengthOf(error);

        if (max === undefined || max === 0) throw error;

        text = FILL_TEXT.slice(0, max);
        await this.call('fill', { tab_id: tabId, ref: target.ref, text });

        return `“${FILL_TEXT}” refused (${target.ref} takes at most ${max} characters), then “${text}” by fill`;
      }
    };

    const filled = await this.step(list, 'fill', async () => {
      const refused: OutlineItem[] = [];

      for (let target = field; ;) {
        try {
          const detail = await fillAt(target);

          field = target;

          return refused.length === 0
            ? detail
            : `${detail}, after ${refused.map((item) => `${item.role} "${item.name.slice(0, 40)}" ${item.ref}`).join(', ')} refused as not a text field`;
        } catch (error) {
          const notText = error instanceof ToolFailure && error.code === 'invalid_target';

          refused.push(target);

          const next = notText
            ? site.field(page.filter((item) => !refused.includes(item)))
            : undefined;

          if (!next || refused.length > 2) throw error;

          target = next;
        }
      }
    });

    if (filled) {
      await this.step(list, 'readback', async () => {
        const { output } = await this.call<Snapshot>('snapshot', { tab_id: tabId, ref: field.ref });

        if (!output.snapshot.includes(text)) {
          throw new Error(
            `snapshot of ${field.ref} lacks the text: ${output.snapshot.slice(0, 160)}`,
          );
        }

        return 'the snapshot shows the text';
      });
    } else this.skip(list, 'readback', 'fill failed');

    if (site.editor) this.skip(list, 'clear', 'editor: text left for you to see');
    else {
      await this.step(list, 'clear', async () => {
        await this.call('fill', { tab_id: tabId, ref: field.ref, text: '' });

        return 'erased';
      });
    }

    await this.step(list, 'press', async () => {
      await this.call('press', { tab_id: tabId, ref: field.ref, key: 'Escape' });

      return 'Escape';
    });
  }

  private async extraSteps(site: Site, run: SiteRun, tabId: number, page: OutlineItem[]) {
    const { steps: list } = run;
    const { select, navigateTo } = site;

    if (select) {
      const target = page.find((item) => item.role === 'combobox' && select.name.test(item.name));

      await this.step(list, 'select', async () => {
        if (!target) throw new Error('no matching <select> in the snapshot');

        const { output } = await this.call<{ navigated: boolean }>('select', {
          tab_id: tabId,
          ref: target.ref,
          values: [select.value],
        });

        return `“${select.value}” in "${target.name}"${output.navigated ? ' (navigated)' : ''}`;
      });
    } else this.skip(list, 'select', 'not tested on this site');

    if (navigateTo) {
      await this.step(list, 'navigate', async () => {
        type Moved = { url: string };

        const there = await this.call<Moved>('navigate', { tab_id: tabId, url: navigateTo });
        const back = await this.call<Moved>('navigate', { tab_id: tabId, go: 'back' });
        const forward = await this.call<Moved>('navigate', { tab_id: tabId, go: 'forward' });

        if (back.output.url !== site.url) throw new Error(`back landed on ${back.output.url}`);

        return `to ${there.output.url}, back, forward to ${forward.output.url}`;
      });
    } else this.skip(list, 'navigate', 'not tested on this site');
  }

  private async wrapUp(sites: Site[]) {
    const tabs = this.state.run;
    const open = sites.flatMap((site) => {
      const tabId = this.siteRun(site.id).tabId;

      return tabId === undefined ? [] : [{ site, tabId }];
    });

    await this.step(tabs, 'tabs_list', async () => {
      const { output } = await this.call<{ tabs: { tab_id: number }[] }>('tabs_list');
      const listed = new Set(output.tabs.map((tab) => tab.tab_id));
      const missing = open.filter(({ tabId }) => !listed.has(tabId));

      if (missing.length > 0) {
        throw new Error(`missing ${missing.map(({ site }) => site.name).join(', ')}`);
      }

      return `${output.tabs.length} tabs in the group`;
    });

    const [first, ...rest] = open;

    if (first) {
      await this.step(tabs, 'tabs_switch', async () => {
        await this.call('tabs_switch', { tab_id: first.tabId });

        return `back to ${first.site.name}`;
      });
    } else this.skip(tabs, 'tabs_switch', 'no tabs');

    for (const { site, tabId } of rest) {
      await this.step(this.siteRun(site.id).steps, 'background', async () => {
        const { output, content } = await this.call<{ width: number; height: number }>(
          'screenshot',
          { tab_id: tabId, scale: 0.5 },
        );

        const image = content.find((item) => item.type === 'file');
        const light = image?.type === 'file' ? await brightness(image.uri) : -1;

        if (light <= 2) throw new Error(`looks blank (brightness ${light})`);

        return `${output.width}×${output.height} while in the background, brightness ${light}`;
      });
    }

    if (first) {
      this.skip(this.siteRun(first.site.id).steps, 'background', 'this tab stays in front');
    }

    const closing = rest.filter(({ site }) => !site.editor);

    await this.step(tabs, 'tabs_close', async () => {
      for (const { tabId } of closing) await this.call('tabs_close', { tab_id: tabId });

      return closing.length > 0
        ? `closed ${closing.map(({ site }) => site.name).join(', ')}`
        : 'nothing to close';
    });

    await this.stopStep(first?.tabId);
  }

  private async stopStep(tabId: number | undefined) {
    const tabs = this.state.run;

    if (this.stopped || tabId === undefined) {
      this.skipRest(tabs, this.stopped ? 'stopped' : 'no tab');

      return;
    }

    const ended = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), STOP_WAIT_MS);

      const off = this.worker.on('run.stopped', ({ runId, reason }) => {
        if (runId !== this.runId) return;

        clearTimeout(timer);
        off();
        resolve(reason);
      });
    });

    this.state.awaitingStop = true;

    const honoured = await this.step(tabs, 'stop', async () => {
      const reason = await ended;

      if (reason === 'timeout') throw new Error('not clicked within 90 s');

      if (reason !== 'user') throw new Error(`the run ended with “${reason}”`);

      return 'the trusted click ended the run';
    });

    this.state.awaitingStop = false;

    if (!honoured) await this.worker.call('run.stop', { runId: this.runId }).catch(() => undefined);

    await this.step(tabs, 'stopped', async () => {
      try {
        await this.call('snapshot', { tab_id: tabId });
      } catch (error) {
        if (error instanceof ToolFailure && error.code === 'stopped') {
          return 'tools answer “stopped”';
        }

        throw error;
      }

      throw new Error('a tool still ran after Stop');
    });

    await this.step(tabs, 'group', async () => {
      const { inside, outside } = await groupMembers(this.state);

      if (outside.length > 0) throw new Error(`outside the group: ${outside.join(', ')}`);

      return `still in the group: ${inside.join(', ') || 'none'}`;
    });
  }
}

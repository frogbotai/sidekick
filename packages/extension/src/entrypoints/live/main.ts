import { groupMembers } from './checks';
import { ICON, questionsFor, toMarkdown } from './report';
import { LiveRunner } from './runner';
import { applyOverrides, OVERRIDES_KEY, SITES } from './sites';
import { freshState, type LiveState, type Step } from './state';

const REPORT_KEY = 'liveReport';

function $(id: string) {
  const element = document.getElementById(id);

  if (!element) throw new Error(`Missing #${id}`);

  return element;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag);

  if (text) element.textContent = text;

  if (className) element.className = className;

  return element;
}

applyOverrides((await chrome.storage.local.get(OVERRIDES_KEY))[OVERRIDES_KEY]);

const state: LiveState = freshState();
const selected = new Set(SITES.filter((site) => !site.signIn).map((site) => site.id));
let runner: LiveRunner | undefined;
let queued = false;

function show(screen: 'start' | 'running' | 'finish') {
  $('start').hidden = screen !== 'start';
  $('running').hidden = screen !== 'running';
  $('finish').hidden = screen !== 'finish';
  $('checklist').hidden = screen === 'start';
}

async function copy(text: string, status: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied ✓';
  } catch {
    status.textContent = 'Copy failed: select the text below and copy it by hand.';

    const area = make('textarea');

    area.value = text;
    area.rows = 10;
    area.style.width = '100%';
    status.after(area);
  }
}

function renderStart() {
  $('sites').replaceChildren(
    ...SITES.map((site) => {
      const item = make('li');
      const label = make('label');
      const box = make('input');

      box.type = 'checkbox';
      box.checked = selected.has(site.id);

      box.addEventListener('change', () => {
        if (box.checked) selected.add(site.id);
        else selected.delete(site.id);
      });

      const tags = [site.signIn ? 'needs sign-in' : '', site.optional ? 'best effort' : '']
        .filter(Boolean)
        .join(', ');

      label.append(box, ` ${site.name}${tags ? ` (${tags})` : ''}`);
      item.append(label, make('small', site.note));

      return item;
    }),
  );

  void chrome.storage.local.get(REPORT_KEY).then((stored) => {
    const report: unknown = stored[REPORT_KEY];

    if (typeof report !== 'string') return;

    $('last').hidden = false;
    $('copyLast').onclick = () => void copy(report, $('copiedLast'));
  });
}

function current() {
  for (const [index, site] of state.sites.filter((entry) => entry.status !== 'skipped').entries()) {
    const running = site.steps.find((step) => step.status === 'running');

    if (running) {
      const total = state.sites.filter((entry) => entry.status !== 'skipped').length;
      const name = SITES.find((entry) => entry.id === site.id)?.name ?? site.id;

      return `Site ${index + 1} of ${total}: ${name} · ${running.label}`;
    }
  }

  const step = state.run.find((entry) => entry.status === 'running');

  return step ? `Wrapping up · ${step.label}` : 'Working…';
}

function stepLine(step: Step) {
  const line = make('div', `${ICON[step.status]} ${step.label}`, 'step');

  if (step.detail) line.append(make('small', step.detail));

  return line;
}

function renderChecklist() {
  const blocks = state.sites
    .filter((site) => site.status !== 'skipped')
    .map((site) => {
      const block = make('div', '', 'site');
      const name = SITES.find((entry) => entry.id === site.id)?.name ?? site.id;

      block.append(make('h3', `${ICON[site.status]} ${name}`), ...site.steps.map(stepLine));

      return block;
    });

  const wrap = make('div', '', 'site');

  wrap.append(make('h3', 'Run'), ...state.run.map(stepLine));
  $('checklist').replaceChildren(...blocks, wrap);
}

function renderRunning() {
  $('progress').textContent = current();

  const front = state.sites.find((site) => site.status !== 'skipped' && site.tabId !== undefined);
  const name = SITES.find((site) => site.id === front?.id)?.name ?? 'first';
  const stopNow = $('stopNow');

  stopNow.hidden = !state.awaitingStop;
  stopNow.textContent = `Now click the red “Stop Sidekick” button at the bottom of the ${name} tab. The test waits up to 90 seconds.`;
}

function renderFinish() {
  $('questions').replaceChildren(
    ...questionsFor(state).map((question) => {
      const item = make('li', question.text);
      const answers = make('div', '', 'answers');

      for (const answer of ['Yes', 'No'] as const) {
        const button = make('button', answer);

        button.type = 'button';

        button.addEventListener('click', () => {
          state.answers[question.id] = answer;

          for (const other of answers.querySelectorAll('button')) {
            other.classList.toggle('chosen', other === button);
          }
        });

        answers.append(button);
      }

      item.append(answers);

      return item;
    }),
  );
}

function render() {
  queued = false;

  if (!state.startedAt) return show('start');

  renderChecklist();

  if (!state.finishedAt) {
    show('running');
    renderRunning();

    return;
  }

  if ($('finish').hidden) {
    renderFinish();
    show('finish');
    void chrome.storage.local.set({ [REPORT_KEY]: toMarkdown(state) });
  }
}

function changed() {
  if (queued) return;

  queued = true;
  requestAnimationFrame(render);
}

$('run').addEventListener('click', () => {
  if (runner || selected.size === 0) return;

  runner = new LiveRunner(state, changed);
  void runner.run(selected);
  changed();
});

$('stop').addEventListener('click', () => runner?.stop());

$('notes').addEventListener('input', (event) => {
  if (event.target instanceof HTMLTextAreaElement) state.notes = event.target.value;
});

const WHEN_COPIED = 'When copied: ';

$('copy').addEventListener('click', async () => {
  const { inside, outside } = await groupMembers(state).catch(() => ({ inside: [], outside: [] }));

  state.events = [
    ...state.events.filter((event) => !event.startsWith(WHEN_COPIED)),
    `${WHEN_COPIED}in the run’s group: ${inside.join(', ') || 'none'}; outside it: ${outside.join(', ') || 'none'}`,
  ];

  const report = toMarkdown(state);

  void chrome.storage.local.set({ [REPORT_KEY]: report });
  void copy(report, $('copied'));
});

renderStart();
render();

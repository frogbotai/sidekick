import { ToolError } from '../../tool/tool';
import { race } from './abort';
import { type Act, cursor, send } from './env';
import {
  type Chord,
  macCommands,
  type Modifier,
  modifierMask,
  parseChord,
  typesText,
} from './keys';
import type { CdpEvent, Point, RefInfo } from './types';

export type Button = 'left' | 'right' | 'middle';

export const DRAG_STEPS = 8;

const BUTTONS: Record<Button, number> = { left: 1, right: 2, middle: 4 };

function mouse(act: Act, type: string, point: Point, extra: Record<string, unknown> = {}) {
  return send(act, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
}

export async function hover(act: Act, point: Point) {
  await cursor(act, point);
  await mouse(act, 'mouseMoved', point, { button: 'none', buttons: 0 });
}

export async function click(
  act: Act,
  point: Point,
  {
    button = 'left',
    count = 1,
    modifiers = [],
  }: { button?: Button; count?: number; modifiers?: Modifier[] },
) {
  const mask = modifierMask(modifiers);

  await hover(act, point);

  for (let clickCount = 1; clickCount <= count; clickCount++) {
    const pressed = { button, buttons: BUTTONS[button], clickCount, modifiers: mask };

    await mouse(act, 'mousePressed', point, pressed);
    await mouse(act, 'mouseReleased', point, { ...pressed, buttons: 0 });
  }
}

function key(
  act: Act,
  type: 'keyDown' | 'rawKeyDown' | 'keyUp',
  chord: Chord,
  extra: Record<string, unknown> = {},
) {
  const { key: description, modifiers } = chord;

  return send(act, 'Input.dispatchKeyEvent', {
    type,
    modifiers: modifierMask(modifiers),
    key: description.key,
    code: description.code,
    windowsVirtualKeyCode: description.keyCode,
    location: description.location,
    ...extra,
  });
}

export async function press(act: Act, combo: string) {
  const chord = parseChord(combo, act.env.mac);
  const held: Modifier[] = [];

  for (const modifier of chord.modifiers) {
    held.push(modifier);

    await key(act, 'rawKeyDown', parseChord(modifier, act.env.mac), {
      modifiers: modifierMask(held),
    });
  }

  const text = typesText(chord.modifiers) ? chord.key.text : '';
  const commands = act.env.mac ? macCommands(chord) : [];

  await key(act, text ? 'keyDown' : 'rawKeyDown', chord, { text, unmodifiedText: text, commands });
  await key(act, 'keyUp', chord);

  for (const modifier of [...chord.modifiers].reverse()) {
    held.splice(held.indexOf(modifier), 1);
    await key(act, 'keyUp', parseChord(modifier, act.env.mac), { modifiers: modifierMask(held) });
  }
}

async function typeKeys(act: Act, text: string) {
  for (const character of text) {
    const chord = parseChord(character === '\n' ? 'Enter' : character, act.env.mac);
    const typed = character === '\n' ? '\r' : character;

    await key(act, 'keyDown', chord, { text: typed, unmodifiedText: typed });
    await key(act, 'keyUp', chord);
  }
}

function same(actual: string, expected: string) {
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim();

  return squash(actual) === squash(expected);
}

async function replace(act: Act, ref: string, text: string, typed: boolean) {
  await race(act.env.page.selectContents(act.tabId, ref), act.signal);

  if (text === '') await press(act, 'Delete');
  else if (typed) await typeKeys(act, text);
  else await send(act, 'Input.insertText', { text });
}

/** Playwright's `fill`: select the contents, one `insertText` (or `Delete`), read back; key events on a mismatch. */
export async function fill(
  act: Act,
  ref: string | undefined,
  text: string,
  { redacted = false, max_length: max }: Partial<RefInfo> = {},
) {
  if (ref === undefined) {
    if (text !== '') await send(act, 'Input.insertText', { text });

    return;
  }

  if (max !== undefined && text.length > max) {
    throw new ToolError(
      'input_mismatch',
      `${ref} accepts at most ${max} characters, and the text has ${text.length}. Shorten it, then fill again.`,
      { max_length: max },
    );
  }

  await replace(act, ref, text, false);

  if (same(await race(act.env.page.readValue(act.tabId, ref), act.signal), text)) return;

  await replace(act, ref, text, true);

  const actual = await race(act.env.page.readValue(act.tabId, ref), act.signal);

  if (same(actual, text)) return;

  throw new ToolError(
    'input_mismatch',
    `${ref} didn’t take the text. Click it and use press, or check it’s an editable field.`,
    redacted ? undefined : { actual },
  );
}

export async function drag(act: Act, from: Point, to: () => Promise<Point>) {
  let intercepted: unknown;

  const stop = act.env.cdp.onEvent((event: CdpEvent) => {
    if (event.tabId === act.tabId && event.method === 'Input.dragIntercepted') {
      intercepted = event.params.data;
    }
  });

  try {
    await send(act, 'Input.setInterceptDrags', { enabled: true });
    await hover(act, from);
    await mouse(act, 'mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });

    const end = await to();
    let entered = false;

    for (let step = 1; step <= DRAG_STEPS; step++) {
      const point = {
        x: from.x + ((end.x - from.x) * step) / DRAG_STEPS,
        y: from.y + ((end.y - from.y) * step) / DRAG_STEPS,
      };

      await cursor(act, point);

      if (intercepted === undefined) {
        await mouse(act, 'mouseMoved', point, { button: 'left', buttons: 1 });
      } else {
        await send(act, 'Input.dispatchDragEvent', {
          type: entered ? 'dragOver' : 'dragEnter',
          ...point,
          data: intercepted,
        });

        entered = true;
      }
    }

    if (intercepted !== undefined) {
      await send(act, 'Input.dispatchDragEvent', { type: 'drop', ...end, data: intercepted });
    }

    await mouse(act, 'mouseReleased', end, { button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    stop();

    await act.env.sessions
      .send(act.tabId, 'Input.setInterceptDrags', { enabled: false })
      .catch(() => undefined);
  }
}

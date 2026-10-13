import { ToolError } from '../../tool/tool';

export const MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;

export type Modifier = (typeof MODIFIERS)[number];

const MASK: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const ALIASES: Record<string, Modifier | 'ControlOrMeta'> = {
  alt: 'Alt',
  option: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  shift: 'Shift',
  controlormeta: 'ControlOrMeta',
};

export interface KeyDescription {
  key: string;
  code: string;
  keyCode: number;
  text: string;
  location: number;
}

const NAMED: Record<string, [code: string, keyCode: number, text?: string]> = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  Escape: ['Escape', 27],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Insert: ['Insert', 45],
  ' ': ['Space', 32, ' '],
  Space: ['Space', 32, ' '],
  Alt: ['AltLeft', 18],
  Control: ['ControlLeft', 17],
  Meta: ['MetaLeft', 91],
  Shift: ['ShiftLeft', 16],
};

const SIDE: Record<string, number> = { AltLeft: 1, ControlLeft: 1, MetaLeft: 1, ShiftLeft: 1 };

const MAC_COMMANDS: Record<string, string[]> = {
  Backspace: ['deleteBackward'],
  Delete: ['deleteForward'],
  ArrowUp: ['moveUp'],
  ArrowDown: ['moveDown'],
  ArrowLeft: ['moveLeft'],
  ArrowRight: ['moveRight'],
  Home: ['scrollToBeginningOfDocument'],
  End: ['scrollToEndOfDocument'],
  PageUp: ['scrollPageUp'],
  PageDown: ['scrollPageDown'],
  'Shift+ArrowUp': ['moveUpAndModifySelection'],
  'Shift+ArrowDown': ['moveDownAndModifySelection'],
  'Shift+ArrowLeft': ['moveLeftAndModifySelection'],
  'Shift+ArrowRight': ['moveRightAndModifySelection'],
  'Shift+Home': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+End': ['moveToEndOfDocumentAndModifySelection'],
  'Control+KeyA': ['moveToBeginningOfParagraph'],
  'Control+KeyE': ['moveToEndOfParagraph'],
  'Control+KeyK': ['deleteToEndOfParagraph'],
  'Alt+Backspace': ['deleteWordBackward'],
  'Alt+Delete': ['deleteWordForward'],
  'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'],
  'Shift+Alt+ArrowLeft': ['moveWordLeftAndModifySelection'],
  'Shift+Alt+ArrowRight': ['moveWordRightAndModifySelection'],
  'Meta+Backspace': ['deleteToBeginningOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Meta+ArrowLeft': ['moveToLeftEndOfLine'],
  'Meta+ArrowRight': ['moveToRightEndOfLine'],
  'Shift+Meta+ArrowUp': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+Meta+ArrowDown': ['moveToEndOfDocumentAndModifySelection'],
  'Shift+Meta+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'],
  'Shift+Meta+ArrowRight': ['moveToRightEndOfLineAndModifySelection'],
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
};

export function modifierMask(modifiers: readonly Modifier[]) {
  return modifiers.reduce((mask, modifier) => mask | MASK[modifier], 0);
}

export function describeKey(name: string, shift: boolean): KeyDescription {
  const named = NAMED[name];

  if (named) {
    const [code, keyCode, text = ''] = named;

    return { key: name === 'Space' ? ' ' : name, code, keyCode, text, location: SIDE[code] ?? 0 };
  }

  const letter = /^(?:Key([A-Z])|([a-zA-Z]))$/.exec(name);

  if (letter) {
    const base = letter[1] ? letter[1].toLowerCase() : (letter[2] ?? '');
    const key = shift ? base.toUpperCase() : base;
    const upper = base.toUpperCase();

    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key, location: 0 };
  }

  const digit = /^(?:Digit)?(\d)$/.exec(name)?.[1];

  if (digit) {
    return {
      key: digit,
      code: `Digit${digit}`,
      keyCode: digit.charCodeAt(0),
      text: digit,
      location: 0,
    };
  }

  const fn = /^F([1-9]|1[0-2])$/.exec(name)?.[1];

  if (fn) return { key: name, code: name, keyCode: 111 + Number(fn), text: '', location: 0 };

  if ([...name].length === 1) return { key: name, code: '', keyCode: 0, text: name, location: 0 };

  throw new ToolError(
    'invalid_target',
    `Unknown key "${name}". Use names like Enter, Tab, ArrowDown, a or Meta+A.`,
  );
}

export interface Chord {
  modifiers: Modifier[];
  key: KeyDescription;
}

export function parseChord(chord: string, mac: boolean): Chord {
  const parts = chord === '+' ? ['+'] : chord.split(/\+(?!$)/);
  const name = parts.pop() ?? '';
  const modifiers: Modifier[] = [];

  for (const part of parts) {
    const alias = ALIASES[part.toLowerCase()];

    if (!alias) {
      throw new ToolError(
        'invalid_target',
        `Unknown modifier "${part}". Use Alt, Control, Meta or Shift.`,
      );
    }

    const modifier = alias === 'ControlOrMeta' ? (mac ? 'Meta' : 'Control') : alias;

    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }

  return {
    modifiers: MODIFIERS.filter((modifier) => modifiers.includes(modifier)),
    key: describeKey(name, modifiers.includes('Shift')),
  };
}

const COMMAND_ORDER: readonly Modifier[] = ['Shift', 'Control', 'Alt', 'Meta'];

export function macCommands(chord: Chord) {
  const held = COMMAND_ORDER.filter((modifier) => chord.modifiers.includes(modifier));

  return MAC_COMMANDS[[...held, chord.key.code].join('+')] ?? [];
}

export function typesText(modifiers: readonly Modifier[]) {
  return modifiers.every((modifier) => modifier === 'Shift');
}

/** One question with fixed choices, after OpenCode v2's `Form.Field` with `custom: false`. */
export interface FormField {
  key: string;
  description: string;
  options: readonly { value: string; label: string }[];
}

export interface FormRequest {
  title: string;
  fields: readonly FormField[];
}

/** A form waiting for the user. */
export interface PendingForm extends FormRequest {
  id: string;
}

export type FormAnswer = Record<string, string>;

export type FormResult = { status: 'answered'; answer: FormAnswer } | { status: 'cancelled' };

interface Entry {
  form: PendingForm;
  settle: (result: FormResult) => void;
}

function invalid(answer: FormAnswer, fields: readonly FormField[]) {
  return fields.some(({ key, options }) => !options.some(({ value }) => value === answer[key]));
}

/**
 * Asks the user questions from tools, after OpenCode v2's `Form.Service`. `ask` waits until the form
 * is answered or cancelled (an aborted signal cancels it); `pending` lists waiting forms oldest first,
 * the same array until one changes; `reply` returns `false` for a settled form or an answer that
 * isn't one of the options.
 */
export function createForms() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: PendingForm[] = [];

  const changed = () => {
    snapshot = [...entries.values()].map(({ form }) => form);

    for (const listener of [...listeners]) listener();
  };

  const settle = (id: string, result: FormResult) => {
    const entry = entries.get(id);

    if (!entry) return false;

    entries.delete(id);
    changed();
    entry.settle(result);

    return true;
  };

  return {
    ask: (request: FormRequest, signal?: AbortSignal) =>
      new Promise<FormResult>((resolve) => {
        if (signal?.aborted) {
          resolve({ status: 'cancelled' });

          return;
        }

        const id = crypto.randomUUID();
        const onAbort = () => settle(id, { status: 'cancelled' });

        entries.set(id, {
          form: { id, ...request },
          settle: (result) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
        });

        signal?.addEventListener('abort', onAbort, { once: true });
        changed();
      }),

    pending: () => snapshot,

    reply: (id: string, answer: FormAnswer) => {
      const entry = entries.get(id);

      if (!entry || invalid(answer, entry.form.fields)) return false;

      return settle(id, { status: 'answered', answer });
    },

    cancel: (id: string) => settle(id, { status: 'cancelled' }),

    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };
}

export type Forms = ReturnType<typeof createForms>;

/** The panel's forms. */
export const forms: Forms = createForms();

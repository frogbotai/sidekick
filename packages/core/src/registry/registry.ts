export interface RegistryDraft<T extends { id: string }> {
  add: (item: T) => void;
  remove: (id: string) => void;
  get: (id: string) => T | undefined;
  list: () => T[];
}

export type RegistryTransform<T extends { id: string }> = (draft: RegistryDraft<T>) => void;

/** `replace` puts the transform in its source's first slot and drops that source's others, whose disposers become no-ops. */
export interface RegisterOptions {
  replace?: boolean;
}

export interface RegistryError {
  source: string;
  error: unknown;
}

export interface Registry<T extends { id: string }> {
  readonly name: string;
  register: (
    source: string,
    transform: RegistryTransform<T>,
    options?: RegisterOptions,
  ) => () => void;
  get: (id: string) => T | undefined;
  list: () => T[];
  revision: () => number;
  errors: () => RegistryError[];
  subscribe: (listener: () => void) => () => void;
}

interface Built<T> {
  items: Map<string, T>;
  errors: RegistryError[];
}

/** Options for a registry. `check` returns why an item is invalid, or `undefined`; an invalid item is skipped and listed in `errors()`. */
export interface RegistryOptions<T> {
  check?: (item: T) => unknown;
}

function draftOf<T extends { id: string }>(
  items: Map<string, T>,
  reject: (item: T) => boolean,
): RegistryDraft<T> {
  return {
    add: (item) => {
      if (!reject(item)) items.set(item.id, item);
    },
    remove: (id) => void items.delete(id),
    get: (id) => items.get(id),
    list: () => [...items.values()],
  };
}

export function createRegistry<T extends { id: string }>(
  name: string,
  { check }: RegistryOptions<T> = {},
): Registry<T> {
  const transforms = new Map<symbol, { source: string; transform: RegistryTransform<T> }>();
  const listeners = new Set<() => void>();
  let version = 0;
  let built: Built<T> | undefined;

  const read = (): Built<T> => {
    if (built) return built;

    let items = new Map<string, T>();
    const errors: RegistryError[] = [];

    for (const { source, transform } of transforms.values()) {
      const attempt = new Map(items);

      const reject = (item: T) => {
        const error = check?.(item);

        if (error !== undefined) errors.push({ source, error });

        return error !== undefined;
      };

      try {
        transform(draftOf(attempt, reject));
        items = attempt;
      } catch (error) {
        errors.push({ source, error });
      }
    }

    built = { items, errors };

    return built;
  };

  const changed = () => {
    built = undefined;
    version++;

    for (const listener of [...listeners]) listener();
  };

  return {
    name,
    register: (source, transform, { replace = false } = {}) => {
      const key = Symbol(source);
      const entry = { source, transform };
      const first = replace
        ? [...transforms.values()].findIndex((item) => item.source === source)
        : -1;

      if (first < 0) {
        transforms.set(key, entry);
      } else {
        const kept = [...transforms].filter(([, item]) => item.source !== source);

        kept.splice(first, 0, [key, entry]);
        transforms.clear();

        for (const [slot, item] of kept) transforms.set(slot, item);
      }

      changed();

      return () => {
        if (transforms.delete(key)) changed();
      };
    },
    get: (id) => read().items.get(id),
    list: () => [...read().items.values()],
    revision: () => version,
    errors: () => [...read().errors],
    subscribe: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };
}

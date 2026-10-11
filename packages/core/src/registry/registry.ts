export interface RegistryDraft<T extends { id: string }> {
  add: (item: T) => void;
  remove: (id: string) => void;
  get: (id: string) => T | undefined;
  list: () => T[];
}

export type RegistryTransform<T extends { id: string }> = (draft: RegistryDraft<T>) => void;

export interface RegistryError {
  source: string;
  error: unknown;
}

export interface Registry<T extends { id: string }> {
  readonly name: string;
  register: (source: string, transform: RegistryTransform<T>) => () => void;
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

function draftOf<T extends { id: string }>(items: Map<string, T>): RegistryDraft<T> {
  return {
    add: (item) => void items.set(item.id, item),
    remove: (id) => void items.delete(id),
    get: (id) => items.get(id),
    list: () => [...items.values()],
  };
}

export function createRegistry<T extends { id: string }>(name: string): Registry<T> {
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

      try {
        transform(draftOf(attempt));
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
    register: (source, transform) => {
      const key = Symbol(source);

      transforms.set(key, { source, transform });
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

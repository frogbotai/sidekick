import { ToolError } from '../../tool/tool';
import { type Fingerprint, fingerprintOf } from './roles';

const REF = /^f(\d+)e(\d+)$/;

export interface Refs {
  /** The ref for an element, refreshing its fingerprint. */
  ref(element: Element, fingerprint: Fingerprint): string;
  /** The live element for a ref, or `stale_ref` with `removed` or `changed`. */
  resolve(ref: string): Element;
}

function same(a: Fingerprint, b: Fingerprint) {
  return a.role === b.role && a.name === b.name && a.href === b.href;
}

export function removed(ref: string) {
  return new ToolError(
    'stale_ref',
    `${ref} is no longer on the page. Take a new snapshot and use its refs.`,
    { reason: 'removed' },
  );
}

/** Refs for one frame's document: `f<frame>e<n>`, lasting as long as the element does. */
export function createRefs(frameId: () => number): Refs {
  const ids = new WeakMap<Element, number>();
  const entries = new Map<number, { element: WeakRef<Element>; fingerprint: Fingerprint }>();
  let next = 1;

  return {
    ref: (element, fingerprint) => {
      let id = ids.get(element);

      if (id === undefined) {
        id = next++;
        ids.set(element, id);
      }

      entries.set(id, { element: new WeakRef(element), fingerprint });

      return `f${frameId()}e${id}`;
    },
    resolve: (ref) => {
      const id = Number(REF.exec(ref)?.[2]);
      const entry = entries.get(id);
      const element = entry?.element.deref();

      if (!entry || !element?.isConnected) throw removed(ref);

      const now = fingerprintOf(element);

      if (!same(now, entry.fingerprint)) {
        const was = `${entry.fingerprint.role} "${entry.fingerprint.name}"`;

        throw new ToolError(
          'stale_ref',
          `${ref} was ${was} and is now ${now.role || 'something else'} "${now.name}". Take a new snapshot.`,
          { reason: 'changed' },
        );
      }

      return element;
    },
  };
}

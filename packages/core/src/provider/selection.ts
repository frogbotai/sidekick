import { z } from 'zod';

import { defineStorageItem } from '../storage';
import { formatModelRef, isModelRef, parseModelRef } from './ref';
import { defaultModel, modelKey, RECENT_LIMIT, type VisibilityModel } from './visibility';

const Ref = z.string().refine(isModelRef, 'Invalid model reference');

export const selectedModel = defineStorageItem('model', Ref.nullable(), null);

export const recentModels = defineStorageItem('recentModels', z.array(Ref).max(RECENT_LIMIT), []);

export const modelVisibility = defineStorageItem(
  'modelVisibility',
  z.record(Ref, z.enum(['show', 'hide'])),
  {},
);

export async function selectModel(ref: string) {
  const { providerID, modelID } = parseModelRef(ref);
  const key = formatModelRef({ providerID, modelID });
  const recent = (await recentModels.get()).filter((entry) => entry !== key);

  await selectedModel.set(ref);
  await recentModels.set([key, ...recent].slice(0, RECENT_LIMIT));
}

/** A model the selection can land on, with the variants a stored ref may name. */
export interface SelectableModel extends VisibilityModel {
  variants: readonly { id: string }[];
}

export interface SelectionInput<T extends SelectableModel> {
  stored: string | null;
  /** Every model the connected providers offer. A stored ref outside it has vanished. */
  available: readonly T[];
  /** The models the picker shows; the default comes from these. */
  visible: readonly T[];
}

/** The model in effect, and the `provider/model` of a stored selection that vanished. */
export interface Selection<T extends SelectableModel> {
  ref?: string;
  model?: T;
  missing?: string;
}

/**
 * The stored selection while its model is available, else the default: the newest visible model.
 * A variant the model no longer has is dropped.
 */
export function effectiveSelection<T extends SelectableModel>({
  stored,
  available,
  visible,
}: SelectionInput<T>): Selection<T> {
  const wanted = stored === null ? undefined : parseModelRef(stored);
  const found =
    wanted &&
    available.find(
      ({ providerID, id }) => providerID === wanted.providerID && id === wanted.modelID,
    );

  if (wanted && found) {
    const known = found.variants.some(({ id }) => id === wanted.variant);

    return {
      ref: formatModelRef(known ? wanted : { ...wanted, variant: undefined }),
      model: found,
    };
  }

  const fallback = defaultModel(visible);
  const missing = wanted && formatModelRef({ ...wanted, variant: undefined });

  return {
    ...(fallback ? { ref: modelKey(fallback), model: fallback } : {}),
    ...(missing ? { missing } : {}),
  };
}

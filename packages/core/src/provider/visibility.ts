/** The fields the default-visibility rules read from a model. */
export interface VisibilityModel {
  providerID: string;
  id: string;
  family?: string;
  release_date?: string;
}

/** A user's explicit choice for one `provider/model`. */
export type Visibility = 'show' | 'hide';

export interface VisibilityOptions {
  now?: number;
  choices?: Readonly<Record<string, Visibility>>;
  pinned?: readonly string[];
}

export const RECENT_LIMIT = 5;

const SIX_MONTHS = 6 * 30.436875 * 24 * 60 * 60 * 1000;

export function modelKey({ providerID, id }: Pick<VisibilityModel, 'providerID' | 'id'>) {
  return `${providerID}/${id}`;
}

function released(model: VisibilityModel) {
  return model.release_date === undefined ? Number.NaN : Date.parse(model.release_date);
}

function latest(models: readonly VisibilityModel[], now: number) {
  const newest = new Map<string, VisibilityModel>();

  for (const model of models) {
    const time = released(model);

    if (!(Math.abs(now - time) < SIX_MONTHS)) continue;

    const group = `${model.providerID}\n${model.family ?? model.id}`;
    const current = newest.get(group);

    if (!current || time > released(current)) newest.set(group, model);
  }

  return new Set([...newest.values()].map(modelKey));
}

export function visibleModels<T extends VisibilityModel>(
  models: readonly T[],
  { now = Date.now(), choices = {}, pinned = [] }: VisibilityOptions = {},
): T[] {
  const newest = latest(models, now);
  const kept = new Set(pinned);

  return models.filter((model) => {
    const key = modelKey(model);
    const choice = choices[key];

    if (choice) return choice === 'show';

    return kept.has(key) || newest.has(key) || !Number.isFinite(released(model));
  });
}

function newer(model: VisibilityModel, than: VisibilityModel) {
  const time = released(model);
  const other = released(than);

  return Number.isFinite(time) && (!Number.isFinite(other) || time > other);
}

/**
 * The default model, as v2's `Model.default` picks it: the newest by release date.
 * Undated models come last; a tie keeps the earlier model.
 */
export function defaultModel<T extends VisibilityModel>(models: readonly T[]): T | undefined {
  let newest: T | undefined;

  for (const model of models) if (!newest || newer(model, newest)) newest = model;

  return newest;
}

import type { ProviderModel } from './definition';
import { formatModelRef, parseModelRef } from './ref';

/** Families tried, in order, for a provider's small model, after OpenCode v2's `Model.small`. */
export const SMALL_FAMILIES = ['gpt-luna', 'gemini-flash-lite', 'gemini-flash', 'claude-haiku'];

/** Variants tried, in order, so the small model reasons as little as it can. */
export const MINIMAL_VARIANTS = ['none', 'minimal', 'low'];

/** The provider's first model in `SMALL_FAMILIES`, if it has one. */
export function smallModel(models: readonly ProviderModel[], providerID: string) {
  const own = models.filter((model) => model.providerID === providerID);

  return SMALL_FAMILIES.flatMap((family) => own.find((model) => model.family === family) ?? [])[0];
}

export interface TitleModelInput {
  /** The title agent's own `model` ref, which wins when set. */
  agentModel?: string;
  /** The session's model ref, the last fallback. */
  sessionModel: string;
  models: readonly ProviderModel[];
}

/**
 * The model ref for a session's title, after v2's `selectTitle`: the title agent's model, else the
 * session provider's small model at its least reasoning, else the session's own model.
 */
export function pickTitleModel({ agentModel, sessionModel, models }: TitleModelInput) {
  if (agentModel) return agentModel;

  const { providerID } = parseModelRef(sessionModel);
  const small = smallModel(models, providerID);

  if (!small) return sessionModel;

  const variant = MINIMAL_VARIANTS.find((id) => small.variants.some((item) => item.id === id));

  return formatModelRef({
    providerID: small.providerID,
    modelID: small.id,
    ...(variant ? { variant } : {}),
  });
}

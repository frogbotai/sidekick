/** A model reference, written `provider/model#variant`. Model ids may contain `/`. */
export interface ModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

export function parseModelRef(input: string): ModelRef {
  const providerEnd = input.indexOf('/');

  if (providerEnd <= 0) throw new Error(`Invalid model reference: ${input}`);

  const providerID = input.slice(0, providerEnd);
  const variantStart = input.indexOf('#', providerEnd + 1);
  const modelID = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
  const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1);

  if (
    !modelID ||
    providerID.includes('#') ||
    (variant !== undefined && (!variant || variant.includes('#')))
  ) {
    throw new Error(`Invalid model reference: ${input}`);
  }

  return variant ? { providerID, modelID, variant } : { providerID, modelID };
}

export function formatModelRef({ providerID, modelID, variant }: ModelRef) {
  return variant ? `${providerID}/${modelID}#${variant}` : `${providerID}/${modelID}`;
}

export function isModelRef(input: string) {
  try {
    parseModelRef(input);

    return true;
  } catch {
    return false;
  }
}

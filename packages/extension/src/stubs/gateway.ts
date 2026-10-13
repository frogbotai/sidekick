const unavailable = (): never => {
  throw new Error('Sidekick has no AI Gateway: pass a provider model, not a model id string');
};

class NoGatewayError extends Error {
  static isInstance() {
    return false;
  }
}

export const GatewayError = NoGatewayError;
export const GatewayAuthenticationError = NoGatewayError;
export const createGateway = unavailable;

export const gateway = Object.assign(unavailable, {
  specificationVersion: 'v4',
  languageModel: unavailable,
  embeddingModel: unavailable,
  imageModel: unavailable,
});

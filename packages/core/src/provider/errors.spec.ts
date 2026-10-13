import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';

import { providerMessage, toUserMessage } from './errors';

function apiError(statusCode: number, responseBody: string) {
  return new APICallError({
    message: 'Not Found',
    url: 'https://api.openai.com/v1/responses',
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

describe('providerMessage', () => {
  it.each([
    ['OpenAI and Anthropic', { error: { message: 'Incorrect API key' } }, 'Incorrect API key'],
    ['Google', [{ error: { code: 400, message: 'API key not valid' } }], 'API key not valid'],
    ['xAI', { code: 'unauthorized', error: 'Incorrect API key' }, 'Incorrect API key'],
    ['Mistral', { message: 'Unauthorized', request_id: 'r' }, 'Unauthorized'],
    ['FastAPI servers', { detail: 'Not authenticated' }, 'Not authenticated'],
  ])('reads %s error bodies', (_shape, body, message) => {
    expect(providerMessage(JSON.stringify(body))).toBe(message);
  });

  it('keeps a plain-text body and ignores an empty one', () => {
    expect(providerMessage('  Bad Gateway \n')).toBe('Bad Gateway');
    expect(providerMessage('')).toBeUndefined();
    expect(providerMessage(JSON.stringify({ ok: false }))).toBeUndefined();
  });
});

describe('toUserMessage', () => {
  it('keeps the provider’s message on a 404 model_not_found', () => {
    const body = JSON.stringify({
      error: { message: 'The model `gpt-0` does not exist', code: 'model_not_found' },
    });

    expect(toUserMessage(apiError(404, body))).toBe('The model `gpt-0` does not exist');
  });

  it('unwraps a retry error to its last attempt', () => {
    const last = apiError(429, JSON.stringify({ error: { message: 'Rate limit reached' } }));
    const error = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [last],
    });

    expect(toUserMessage(error)).toBe('Rate limit reached');
  });

  it('falls back to the error’s own message, then a generic one', () => {
    expect(toUserMessage(apiError(502, ''))).toBe('Not Found');

    expect(toUserMessage(new Error('Model unavailable: openai/gpt-0'))).toBe(
      'Model unavailable: openai/gpt-0',
    );

    expect(toUserMessage(undefined)).toBe('Something went wrong');
  });
});

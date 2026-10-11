import * as z from 'zod/mini';
import type { $ZodType, input, output } from 'zod/v4/core';

export interface MethodDefinition {
  input: $ZodType;
  output: $ZodType;
}

export type Methods = Record<string, MethodDefinition>;

export type Events = Record<string, $ZodType>;

export const CONNECTED = 'worker.connected';

const connected = z.object({ bootId: z.string().check(z.minLength(1)) });

export type Connected = { [CONNECTED]: typeof connected };

export interface Protocol<M extends Methods = Methods, E extends Events = Events> {
  methods: M;
  events: E & Connected;
}

export type Input<M extends Methods, K extends keyof M> = input<M[K]['input']>;

export type Output<M extends Methods, K extends keyof M> = output<M[K]['output']>;

export type Handlers<M extends Methods> = {
  [K in keyof M]: (
    input: output<M[K]['input']>,
  ) => input<M[K]['output']> | Promise<input<M[K]['output']>>;
};

export function defineProtocol<
  const M extends Methods,
  const E extends Events = Record<never, never>,
>(definition: { methods: M; events?: E }): Protocol<M, E> {
  const events = definition.events ?? {};

  if (CONNECTED in events) throw new Error(`"${CONNECTED}" is reserved`);

  return {
    methods: definition.methods,
    events: { ...events, [CONNECTED]: connected } as E & Connected,
  };
}

import * as z from 'zod/mini';

import { defineProtocol } from './rpc/define';

const frameId = z.int().check(z.nonnegative());

export const sidekickProtocol = defineProtocol({
  methods: {
    'tab.ping': {
      input: z.object({ tabId: z.int().check(z.nonnegative()), frameId }),
      output: z.object({ frameId, url: z.string(), bootId: z.string() }),
    },
  },
});

export const frameProtocol = defineProtocol({
  methods: {
    'frame.ping': { input: z.object({}), output: z.object({ url: z.string() }) },
  },
});

import type { sidekickProtocol, WorkerClient } from '@frogbotai/sidekick-core';
import { createContext, useContext } from 'react';

export type SidekickWorker = WorkerClient<typeof sidekickProtocol>;

export const WorkerContext = createContext<SidekickWorker | null>(null);

export function useWorker() {
  const worker = useContext(WorkerContext);

  if (!worker) throw new Error('useWorker needs a WorkerContext provider');

  return worker;
}

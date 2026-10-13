import { ToolError } from '../../tool/tool';

export function stopped() {
  return new ToolError('stopped', 'The run was stopped. Wait for the user before acting again.');
}

export function checkpoint(signal: AbortSignal) {
  if (signal.aborted) throw stopped();
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(stopped());

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(stopped());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function race<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeout?: { ms: number; what: string },
): Promise<T> {
  checkpoint(signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};

  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(stopped());

    signal.addEventListener('abort', onAbort, { once: true });

    if (timeout) {
      timer = setTimeout(
        () =>
          reject(
            new ToolError('timeout', `${timeout.what} took over ${timeout.ms} ms. Try again.`),
          ),
        timeout.ms,
      );
    }
  });

  return Promise.race([promise, interrupted]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

import { resolveModel, toUserMessage } from '@frogbotai/sidekick-core/provider';
import { Alert, AlertDescription, Button } from '@frogbotai/ui';
import { streamText } from 'ai';
import { useEffect, useRef, useState } from 'react';

import { currentCatalog } from './catalog';

const PROMPT = 'Say hello in one short sentence.';

export function TryIt({ modelRef }: { modelRef?: string }) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const run = async (ref: string) => {
    controller.current?.abort();

    const abort = new AbortController();

    controller.current = abort;
    setReply('');
    setError(undefined);
    setRunning(true);

    try {
      const result = streamText({
        model: await resolveModel(ref, currentCatalog()),
        prompt: PROMPT,
        abortSignal: abort.signal,
      });

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') setReply((text) => text + part.text);
        else if (part.type === 'error') throw part.error;
      }
    } catch (failure) {
      if (!abort.signal.aborted) setError(toUserMessage(failure));
    } finally {
      if (controller.current === abort) setRunning(false);
    }
  };

  return (
    <section className="sidekick-stack" aria-label="Try it">
      <Button disabled={!modelRef || running} onClick={() => modelRef && void run(modelRef)}>
        {running ? 'Streaming…' : 'Try it'}
      </Button>
      {reply ? <output aria-label="Reply">{reply}</output> : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

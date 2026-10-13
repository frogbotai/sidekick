import type { KeyTest } from '@frogbotai/sidekick-core/provider';
import { Alert, AlertDescription, AlertTitle, Button } from '@frogbotai/ui';

const TITLES: Record<KeyTest['status'], (name: string) => string> = {
  ok: (name) => `${name} answered`,
  'bad-key': (name) => `${name} rejected the key`,
  unreachable: (name) => `Couldn't reach ${name}`,
  'origin-refused': (name) => `${name} refused Sidekick`,
  error: (name) => `${name} returned an error`,
};

export function KeyTestResult({ result, name }: { result: KeyTest; name: string }) {
  const fix = result.status === 'origin-refused' ? result.fix : undefined;

  return (
    <Alert variant={result.status === 'ok' ? 'primary' : 'destructive'}>
      <AlertTitle>{TITLES[result.status](name)}</AlertTitle>
      {result.status === 'ok' ? null : <AlertDescription>{result.message}</AlertDescription>}
      {fix ? (
        <AlertDescription className="sidekick-row">
          <code>{fix}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(fix)}
          >
            Copy
          </Button>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

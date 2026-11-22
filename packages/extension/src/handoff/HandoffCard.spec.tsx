import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HandoffCard } from './HandoffCard';

const ask = { id: 'hand_1', message: 'Show me how you order', tabId: 1 };

describe('the handoff card in the panel', () => {
  it('says the person is recorded only while a demonstration records (sidekick-21 req. 7)', () => {
    const recording = renderToStaticMarkup(
      <HandoffCard ask={{ ...ask, recording: true }} onContinue={() => undefined} />,
    );

    const plain = renderToStaticMarkup(<HandoffCard ask={ask} onContinue={() => undefined} />);

    expect(recording).toContain('Show me how you order');
    expect(recording).toContain('Sidekick is recording your clicks and typing');
    expect(plain).not.toContain('recording');
  });
});

import type { PermissionAsk } from '@frogbotai/sidekick-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { denial, PermissionCard } from './PermissionCard';

const ask: PermissionAsk = {
  id: 'per_1',
  sessionID: 'ses_1',
  callID: 'call_1',
  action: 'input',
  site: 'js.stripe.com',
  inside: 'shop.example',
  always: true,
};

describe('the permission card', () => {
  it('names the frame’s site and its page, and hides Always on a sensitive site', () => {
    const always = renderToStaticMarkup(<PermissionCard ask={ask} onReply={() => undefined} />);
    const never = renderToStaticMarkup(
      <PermissionCard ask={{ ...ask, always: false }} onReply={() => undefined} />,
    );

    expect(always).toContain(
      'Allow Sidekick to click and type on <strong>js.stripe.com</strong> inside <strong>shop.example</strong>?',
    );

    expect(always).toContain('Always allow');
    expect(never).not.toContain('Always allow');
    expect(never).toContain('Sidekick asks every time on this site.');
  });

  it('sends a typed note with Deny, and a plain Deny without one', () => {
    expect(denial('  Use the search box ')).toEqual({
      reply: 'reject',
      message: 'Use the search box',
    });

    expect(denial('  ')).toEqual({ reply: 'reject' });
  });
});

import { describe, expect, it } from 'vitest';

import { pathOf, routeOf, SETTINGS_PATH } from './paths';

describe('nav paths', () => {
  it('round-trips the chat, a chat by id and each view', () => {
    expect(pathOf('chat')).toBe('/chat');
    expect(routeOf(pathOf('chat'))).toEqual({ page: 'chat' });
    expect(pathOf('chat', 'ses/1 2')).toBe('/chat/ses%2F1%202');
    expect(routeOf(pathOf('chat', 'ses/1 2'))).toEqual({ page: 'chat', chatId: 'ses/1 2' });

    for (const page of ['chats', 'providers', 'commands', 'agents', 'help'] as const) {
      expect(routeOf(pathOf(page))).toEqual({ page });
    }
  });

  it('reads Settings as the options page and ignores unknown paths', () => {
    expect(routeOf(SETTINGS_PATH)).toEqual({ page: 'settings' });
    expect(routeOf('/admin')).toBeUndefined();
    expect(routeOf('/')).toBeUndefined();
  });
});

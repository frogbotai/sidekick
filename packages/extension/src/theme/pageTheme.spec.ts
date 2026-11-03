// @vitest-environment happy-dom
import type { ThemeMode } from '@frogbotai/ui/theme';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootPageTheme, followPageTheme } from './pageTheme';

let systemDark = false;
const systemListeners = new Set<() => void>();

function setSystem(dark: boolean) {
  systemDark = dark;

  for (const listener of systemListeners) listener();
}

function storage() {
  const listeners = new Set<(mode: ThemeMode) => void>();

  return {
    set: (mode: ThemeMode) => {
      for (const listener of listeners) listener(mode);
    },
    watch: (listener: (mode: ThemeMode) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

const pageTheme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  systemDark = false;
  systemListeners.clear();
  localStorage.clear();
  delete document.documentElement.dataset.theme;

  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return systemDark;
    },
    addEventListener: (_type: string, listener: () => void) => systemListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => systemListeners.delete(listener),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page theme', () => {
  it('boots from the system before anything is mirrored, then from the mirrored mode', () => {
    systemDark = true;
    bootPageTheme();

    expect(pageTheme()).toBe('dark');

    const stop = followPageTheme('light', storage().watch);

    stop();
    delete document.documentElement.dataset.theme;
    bootPageTheme();

    expect(pageTheme()).toBe('light');
  });

  it('follows stored changes and, on system, the system', () => {
    const stored = storage();
    const stop = followPageTheme('system', stored.watch);

    expect(pageTheme()).toBe('light');

    setSystem(true);

    expect(pageTheme()).toBe('dark');

    stored.set('light');

    expect(pageTheme()).toBe('light');

    setSystem(false);
    setSystem(true);

    expect(pageTheme()).toBe('light');
    expect(localStorage.getItem('sidekick:theme')).toBe('light');

    stop();
    stored.set('dark');

    expect(pageTheme()).toBe('light');
    expect(systemListeners.size).toBe(0);
  });
});

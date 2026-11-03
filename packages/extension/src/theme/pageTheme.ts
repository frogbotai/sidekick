import type { ResolvedThemeMode, ThemeMode } from '@frogbotai/ui/theme';

const MIRROR = 'sidekick:theme';

const DARK = '(prefers-color-scheme: dark)';

function resolve(mode: ThemeMode): ResolvedThemeMode {
  if (mode !== 'system') return mode;

  return matchMedia(DARK).matches ? 'dark' : 'light';
}

function paint(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolve(mode);
}

/** Themes `<html>` before first paint, from the mode `followPageTheme` last mirrored to `localStorage`. */
export function bootPageTheme() {
  const mirrored = localStorage.getItem(MIRROR);

  paint(mirrored === 'light' || mirrored === 'dark' ? mirrored : 'system');
}

/**
 * Keeps `<html data-theme>`, which FrogBot UI's page tokens switch on, on the stored mode, and on
 * the system's while that is `system`. Returns a stop.
 */
export function followPageTheme(
  initial: ThemeMode,
  watch: (listener: (mode: ThemeMode) => void) => () => void,
) {
  let mode = initial;

  const apply = (next: ThemeMode) => {
    mode = next;
    localStorage.setItem(MIRROR, next);
    paint(next);
  };

  const query = matchMedia(DARK);
  const onSystem = () => paint(mode);

  apply(initial);
  query.addEventListener('change', onSystem);

  const unwatch = watch(apply);

  return () => {
    unwatch();
    query.removeEventListener('change', onSystem);
  };
}

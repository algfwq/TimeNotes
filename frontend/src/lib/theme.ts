export type ThemeMode = 'light' | 'dark';
export type ThemePreference = ThemeMode | 'system';

export const THEME_STORAGE_KEY = 'timenotes.theme';
export const THEME_CHANGE_EVENT = 'timenotes:theme-change';

export function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }
  } catch {
    // ignore storage failures
  }
  return 'system';
}

export function resolveTheme(preference: ThemePreference): ThemeMode {
  return preference === 'system' ? getSystemTheme() : preference;
}

export function writeThemePreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // ignore storage failures
  }
}

/** Apply theme to document for Semi + our chrome CSS. */
export function applyDocumentTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const body = document.body;

  root.classList.toggle('dark', mode === 'dark');
  root.classList.toggle('theme-dark', mode === 'dark');
  root.classList.toggle('theme-light', mode === 'light');
  root.dataset.theme = mode;
  root.style.colorScheme = mode;

  if (mode === 'dark') {
    body.setAttribute('theme-mode', 'dark');
    body.classList.add('semi-always-dark');
    body.classList.remove('semi-always-light');
  } else {
    body.removeAttribute('theme-mode');
    body.classList.remove('semi-always-dark');
    body.classList.add('semi-always-light');
  }

  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, {
      detail: { theme: mode },
    }),
  );
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

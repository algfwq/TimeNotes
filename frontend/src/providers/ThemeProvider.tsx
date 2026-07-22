import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  applyDocumentTheme,
  getSystemTheme,
  prefersReducedMotion,
  readThemePreference,
  resolveTheme,
  type ThemeMode,
  type ThemePreference,
  writeThemePreference,
} from '../lib/theme';

type ThemeContextValue = {
  theme: ThemeMode;
  preference: ThemePreference;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: (origin?: { x: number; y: number }) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

function runThemeTransition(next: ThemeMode, origin?: { x: number; y: number }) {
  const root = document.documentElement;
  const reduced = prefersReducedMotion();
  const doc = document as DocumentWithViewTransition;

  const commit = () => applyDocumentTheme(next);

  if (reduced || typeof doc.startViewTransition !== 'function') {
    commit();
    return;
  }

  const x = origin?.x ?? window.innerWidth - 28;
  const y = origin?.y ?? window.innerHeight - 24;
  root.style.setProperty('--theme-reveal-x', `${x}px`);
  root.style.setProperty('--theme-reveal-y', `${y}px`);
  root.dataset.themeTransition = next === 'dark' ? 'to-dark' : 'to-light';

  const transition = doc.startViewTransition(() => {
    commit();
  });

  void transition.finished.finally(() => {
    delete root.dataset.themeTransition;
    root.style.removeProperty('--theme-reveal-x');
    root.style.removeProperty('--theme-reveal-y');
  });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(readThemePreference()));

  // Keep document theme in sync for system preference changes only.
  // Manual toggles apply inside startViewTransition so the reveal can capture before/after.
  useEffect(() => {
    if (preference !== 'system') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = getSystemTheme();
      setThemeState(next);
      applyDocumentTheme(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setPreference(mode);
    writeThemePreference(mode);
    setThemeState(mode);
    applyDocumentTheme(mode);
  }, []);

  const toggleTheme = useCallback(
    (origin?: { x: number; y: number }) => {
      const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
      setPreference(next);
      writeThemePreference(next);
      setThemeState(next);
      runThemeTransition(next, origin);
    },
    [theme],
  );

  useEffect(() => {
    const onMenuToggle = () => toggleTheme();
    window.addEventListener('timenotes:toggle-theme', onMenuToggle);
    return () => window.removeEventListener('timenotes:toggle-theme', onMenuToggle);
  }, [toggleTheme]);

  const value = useMemo(
    () => ({
      theme,
      preference,
      setTheme,
      toggleTheme,
    }),
    [theme, preference, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}

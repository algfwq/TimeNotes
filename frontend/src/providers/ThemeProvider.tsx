import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
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

type ViewTransition = {
  finished: Promise<void>;
  ready: Promise<void>;
  skipTransition: () => void;
};

type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void) => ViewTransition;
};

const REVEAL_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

let activeThemeTransition: ViewTransition | null = null;

function resolveRevealOrigin(origin?: { x: number; y: number }) {
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    return origin;
  }
  const toggle = document.querySelector<HTMLElement>('[data-theme-toggle]');
  if (toggle) {
    const rect = toggle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { x: window.innerWidth - 28, y: window.innerHeight - 24 };
}

function coverRadius(x: number, y: number) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y)));
}

function animateThemeReveal(next: ThemeMode, x: number, y: number) {
  const radius = coverRadius(x, y);
  const toDark = next === 'dark';
  const frames = toDark
    ? [
        { clipPath: `circle(0px at ${x}px ${y}px)` },
        { clipPath: `circle(${radius}px at ${x}px ${y}px)` },
      ]
    : [
        { clipPath: `circle(${radius}px at ${x}px ${y}px)` },
        { clipPath: `circle(0px at ${x}px ${y}px)` },
      ];

  document.documentElement.animate(frames, {
    duration: toDark ? 460 : 400,
    easing: REVEAL_EASE,
    fill: 'both',
    pseudoElement: toDark ? '::view-transition-new(root)' : '::view-transition-old(root)',
  });
}

function clearThemeTransition(root: HTMLElement) {
  delete root.dataset.themeTransition;
}

function runThemeTransition(next: ThemeMode, origin: { x: number; y: number } | undefined, commitReact: () => void) {
  const root = document.documentElement;
  const commit = () => {
    applyDocumentTheme(next);
    flushSync(commitReact);
  };

  const doc = document as DocumentWithViewTransition;
  if (prefersReducedMotion() || typeof doc.startViewTransition !== 'function') {
    commit();
    return;
  }

  if (activeThemeTransition) {
    try {
      activeThemeTransition.skipTransition();
    } catch {
      // A skipped transition still settles in `finished`.
    }
  }

  const { x, y } = resolveRevealOrigin(origin);
  root.dataset.themeTransition = next === 'dark' ? 'to-dark' : 'to-light';

  let transition: ViewTransition;
  try {
    transition = doc.startViewTransition(() => {
      commit();
    });
  } catch {
    clearThemeTransition(root);
    commit();
    return;
  }

  activeThemeTransition = transition;

  void transition.ready
    .then(() => {
      animateThemeReveal(next, x, y);
    })
    .catch(() => {
      // ready rejects when the transition is skipped.
    });

  void transition.finished.finally(() => {
    if (activeThemeTransition === transition) {
      activeThemeTransition = null;
    }
    clearThemeTransition(root);
  });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(readThemePreference()));

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
      writeThemePreference(next);
      runThemeTransition(next, origin, () => {
        setPreference(next);
        setThemeState(next);
      });
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

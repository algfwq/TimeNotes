import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '@douyinfe/semi-ui';
import { useTheme } from '../providers/ThemeProvider';

/**
 * Status-bar theme control: sun/moon morph with press feedback and a
 * circular view-transition reveal anchored to the button.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const btnRef = useRef<HTMLButtonElement>(null);
  const [bump, setBump] = useState(false);
  const bumpTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (bumpTimer.current !== null) {
        window.clearTimeout(bumpTimer.current);
      }
    };
  }, []);

  const handleToggle = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    const origin = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : undefined;

    setBump(true);
    if (bumpTimer.current !== null) {
      window.clearTimeout(bumpTimer.current);
    }
    bumpTimer.current = window.setTimeout(() => setBump(false), 420);

    toggleTheme(origin);

    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(8);
      }
    } catch {
      // ignore
    }
  };

  const label = isDark ? '切换到浅色模式' : '切换到深色模式';
  const size = compact ? 28 : 32;

  const button = (
    <button
      ref={btnRef}
      type="button"
      className={`theme-toggle ${isDark ? 'theme-toggle--dark' : 'theme-toggle--light'}${bump ? ' theme-toggle--bump' : ''}`}
      style={{ width: size, height: size }}
      aria-label={label}
      aria-pressed={isDark}
      title={label}
      onPointerDown={(event) => {
        // Instant press feedback (Apple: respond on down, not click).
        event.currentTarget.classList.add('theme-toggle--pressed');
      }}
      onPointerUp={(event) => {
        event.currentTarget.classList.remove('theme-toggle--pressed');
      }}
      onPointerLeave={(event) => {
        event.currentTarget.classList.remove('theme-toggle--pressed');
      }}
      onPointerCancel={(event) => {
        event.currentTarget.classList.remove('theme-toggle--pressed');
      }}
      onClick={handleToggle}
    >
      <span className="theme-toggle__glow" aria-hidden />
      <span className="theme-toggle__orbit" aria-hidden>
        <span className="theme-toggle__icon theme-toggle__icon--sun">
          <SunIcon />
        </span>
        <span className="theme-toggle__icon theme-toggle__icon--moon">
          <MoonIcon />
        </span>
      </span>
      <span className="theme-toggle__spark theme-toggle__spark--a" aria-hidden />
      <span className="theme-toggle__spark theme-toggle__spark--b" aria-hidden />
      <span className="theme-toggle__spark theme-toggle__spark--c" aria-hidden />
    </button>
  );

  if (compact) {
    return button;
  }

  return (
    <Tooltip content={label} position="top">
      {button}
    </Tooltip>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4.25" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M12 2.75v2.1" />
        <path d="M12 19.15v2.1" />
        <path d="M2.75 12h2.1" />
        <path d="M19.15 12h2.1" />
        <path d="M5.22 5.22l1.48 1.48" />
        <path d="M17.3 17.3l1.48 1.48" />
        <path d="M5.22 18.78l1.48-1.48" />
        <path d="M17.3 6.7l1.48-1.48" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
      <path
        d="M15.2 3.4a8.6 8.6 0 1 0 5.4 15.2 7.15 7.15 0 0 1-5.4-15.2z"
        fill="currentColor"
      />
    </svg>
  );
}

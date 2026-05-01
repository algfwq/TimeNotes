import { LogService } from '../../bindings/changeme';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function logFrontend(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
  const consoleMethod = level === 'debug' ? 'log' : level;
  console[consoleMethod](`[TimeNotes] ${message}`, fields);
  void LogService.Frontend(level, message, fields as Record<string, any>).catch(() => {
    // Browser preview mode has no Wails bridge; console output remains available there.
  });
}

export function installFrontendLogging() {
  logFrontend('info', 'frontend_ready', { href: window.location.href });
  window.addEventListener('error', (event) => {
    logFrontend('error', 'window_error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    logFrontend('error', 'unhandled_rejection', {
      reason: event.reason instanceof Error ? event.reason.message : String(event.reason),
    });
  });
}

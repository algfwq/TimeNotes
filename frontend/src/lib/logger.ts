import { LogService } from '../../bindings/changeme';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface PendingLog {
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
  createdAt: string;
}

const pendingLogs: PendingLog[] = [];
let flushing = false;
let backendAvailable = true;

export function logFrontend(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
  const consoleMethod = level === 'debug' ? 'log' : level;
  console[consoleMethod](`[TimeNotes] ${message}`, fields);
  pendingLogs.push({ level, message, fields, createdAt: new Date().toISOString() });
  if (pendingLogs.length > 200) {
    pendingLogs.splice(0, pendingLogs.length - 200);
  }
  void flushFrontendLogs();
}

export function installFrontendLogging() {
  logFrontend('info', 'frontend_ready', collectRuntimeSnapshot());
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
  window.addEventListener('pagehide', () => {
    logFrontend('info', 'page_hide', collectRuntimeSnapshot());
  });
}

async function flushFrontendLogs() {
  if (flushing || !backendAvailable) {
    return;
  }
  flushing = true;
  try {
    while (pendingLogs.length > 0) {
      const entry = pendingLogs[0];
      await LogService.Frontend(entry.level, entry.message, {
        ...entry.fields,
        createdAt: entry.createdAt,
      } as Record<string, any>);
      pendingLogs.shift();
    }
    backendAvailable = true;
  } catch {
    // Browser preview 或 Wails bridge 尚未就绪时先保留队列，稍后再试。
    backendAvailable = false;
    window.setTimeout(() => {
      backendAvailable = true;
      void flushFrontendLogs();
    }, 1_000);
  } finally {
    flushing = false;
  }
}

function collectRuntimeSnapshot() {
  const memory = (performance as any).memory;
  return {
    href: window.location.href,
    visibility: document.visibilityState,
    elements: document.querySelectorAll('[data-element-id]').length,
    images: document.images.length,
    usedJSHeapSize: memory?.usedJSHeapSize,
    totalJSHeapSize: memory?.totalJSHeapSize,
    jsHeapSizeLimit: memory?.jsHeapSizeLimit,
  };
}

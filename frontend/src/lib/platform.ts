import { System } from '@wailsio/runtime';

type WailsHost = {
  wails?: {
    platform?: () => string;
  };
  webkit?: {
    messageHandlers?: {
      external?: unknown;
    };
  };
};

/**
 * Detect mobile Wails hosts.
 * This @wailsio/runtime build has no System.IsMobile(); use bridge + UA fallbacks.
 */
export function isMobile(): boolean {
  return isAndroid() || isIOS();
}

export function isAndroid(): boolean {
  try {
    const host = window as unknown as WailsHost;
    if (typeof host.wails?.platform === 'function') {
      return String(host.wails.platform()).toLowerCase() === 'android';
    }
  } catch {
    // ignore
  }
  return /Android/i.test(navigator.userAgent || '');
}

export function isIOS(): boolean {
  try {
    const host = window as unknown as WailsHost;
    if (host.webkit?.messageHandlers?.external) {
      // iOS Wails injects the WKWebView message handler; exclude desktop Safari.
      if (typeof host.wails?.platform === 'function') {
        return String(host.wails.platform()).toLowerCase() === 'ios';
      }
      // Prefer explicit iOS UA when bridge shape is ambiguous.
    }
  } catch {
    // ignore
  }
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

export function isDesktop(): boolean {
  return !isMobile() && (System.IsWindows() || System.IsMac() || System.IsLinux());
}

/** Optional async refinement via Environment().OS (android/ios/windows/...). */
export async function environmentOS(): Promise<string> {
  try {
    const env = await System.Environment();
    return String(env?.OS || '').toLowerCase();
  } catch {
    return '';
  }
}

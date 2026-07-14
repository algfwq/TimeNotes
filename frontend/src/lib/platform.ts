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
 * 应用壳布局档位（按**当前窗口宽度**，不是一刀切 isMobile）。
 * - full：与桌面一致的完整 chrome（文字按钮、双侧栏可显）
 * - compact：窄屏压缩 chrome（图标工具、可选隐藏属性栏）
 */
export type ShellLayout = {
  mode: 'full' | 'compact';
  width: number;
  height: number;
  /** 是否显示右侧属性面板 */
  showInspector: boolean;
  /** 是否使用压缩顶栏/底栏（仅窄屏） */
  compactChrome: boolean;
  defaultLeft: number;
  defaultRight: number;
  minLeft: number;
  maxLeft: number;
  minRight: number;
  maxRight: number;
  /** 画布至少保留宽度，防止侧栏拖太宽 */
  minCanvas: number;
};

/** 宽度达到此值：完整 UI（与桌面一致） */
const FULL_UI_MIN_WIDTH = 960;
/** 宽度达到此值：显示右侧属性栏 */
const INSPECTOR_MIN_WIDTH = 900;

/**
 * Detect mobile Wails hosts.
 * This @wailsio/runtime build has no System.IsMobile(); use bridge + UA fallbacks.
 */
export function isMobile(): boolean {
  return isAndroid() || isIOS();
}

/**
 * 按屏幕宽度计算壳布局。桌面始终 full；移动端/平板随宽度切换。
 */
export function getShellLayout(): ShellLayout {
  const width = typeof window !== 'undefined' ? window.innerWidth || 0 : 1280;
  const height = typeof window !== 'undefined' ? window.innerHeight || 0 : 800;
  const minCanvas = 240;

  if (!isMobile()) {
    return {
      mode: 'full',
      width,
      height,
      showInspector: true,
      compactChrome: false,
      defaultLeft: 306,
      defaultRight: 340,
      minLeft: 220,
      maxLeft: 520,
      minRight: 220,
      maxRight: 520,
      minCanvas,
    };
  }

  // 大屏平板 / 分屏足够宽：与桌面 UI 一致
  if (width >= FULL_UI_MIN_WIDTH) {
    return {
      mode: 'full',
      width,
      height,
      showInspector: true,
      compactChrome: false,
      defaultLeft: 306,
      defaultRight: 340,
      minLeft: 200,
      maxLeft: Math.max(280, Math.floor(width * 0.35)),
      minRight: 220,
      maxRight: Math.max(280, Math.floor(width * 0.35)),
      minCanvas,
    };
  }

  // 中等宽度：仍可开属性栏，但顶栏压缩
  const showInspector = width >= INSPECTOR_MIN_WIDTH;
  return {
    mode: 'compact',
    width,
    height,
    showInspector,
    compactChrome: true,
    defaultLeft: Math.min(220, Math.max(160, Math.floor(width * 0.22))),
    defaultRight: 280,
    minLeft: 160,
    maxLeft: Math.max(200, Math.floor(width * 0.4)),
    minRight: 200,
    maxRight: Math.max(220, Math.floor(width * 0.4)),
    minCanvas,
  };
}

/** @deprecated 使用 getShellLayout；保留避免旧引用编译失败 */
export type MobileLayoutProfile = {
  compactChrome: boolean;
  tablet: boolean;
  width: number;
  height: number;
};

export function getMobileLayoutProfile(): MobileLayoutProfile {
  const shell = getShellLayout();
  return {
    compactChrome: shell.compactChrome,
    tablet: shell.mode === 'full' && isMobile(),
    width: shell.width,
    height: shell.height,
  };
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
      if (typeof host.wails?.platform === 'function') {
        return String(host.wails.platform()).toLowerCase() === 'ios';
      }
    }
  } catch {
    // ignore
  }
  return /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

export function isDesktop(): boolean {
  return !isMobile() && (System.IsWindows() || System.IsMac() || System.IsLinux());
}

export async function environmentOS(): Promise<string> {
  try {
    const env = await System.Environment();
    return String(env?.OS || '').toLowerCase();
  } catch {
    return '';
  }
}

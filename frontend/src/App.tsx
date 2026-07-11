import { useEffect, useState } from 'react';
import { ConfigProvider, Toast } from '@douyinfe/semi-ui';
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import { AppShell } from './components/AppShell';
import { CollaborationProvider } from './providers/CollaborationProvider';
import { DocumentProvider } from './providers/DocumentProvider';

Toast.config({ duration: 2 });

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function App() {
  const [theme] = useState<'light' | 'dark'>(() => getSystemTheme());
  useBrowserPageZoomGuard();

  // macOS 深色模式：通过 body class 控制 Semi Design 主题
  useEffect(() => {
    const applyTheme = (t: 'light' | 'dark') => {
      if (t === 'dark') {
        document.body.classList.add('semi-always-dark');
      } else {
        document.body.classList.remove('semi-always-dark');
      }
    };

    applyTheme(theme);

    // 监听 macOS 系统外观变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      applyTheme(event.matches ? 'dark' : 'light');
    };
    mediaQuery.addEventListener('change', handleChange);

    // macOS 菜单栏手动切换 (Cmd+Shift+D)
    const handleToggleTheme = () => {
      const isDark = !document.body.classList.contains('semi-always-dark');
      applyTheme(isDark ? 'dark' : 'light');
    };
    window.addEventListener('timenotes:toggle-theme', handleToggleTheme);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
      window.removeEventListener('timenotes:toggle-theme', handleToggleTheme);
    };
  }, [theme]);

  return (
    <ConfigProvider locale={zhCN}>
      <DocumentProvider>
        <CollaborationProvider>
          <AppShell />
        </CollaborationProvider>
      </DocumentProvider>
    </ConfigProvider>
  );
}

export default App;

function useBrowserPageZoomGuard() {
  useEffect(() => {
    const preventPageWheelZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };
    const preventPageKeyZoom = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === '+' || key === '=' || key === '-' || key === '_' || key === '0') {
        event.preventDefault();
      }
    };
    window.addEventListener('wheel', preventPageWheelZoom, { capture: true, passive: false });
    window.addEventListener('keydown', preventPageKeyZoom, { capture: true });
    return () => {
      window.removeEventListener('wheel', preventPageWheelZoom, { capture: true });
      window.removeEventListener('keydown', preventPageKeyZoom, { capture: true });
    };
  }, []);
}

import { useEffect } from 'react';
import { ConfigProvider, Toast } from '@douyinfe/semi-ui';
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import { AppShell } from './components/AppShell';
import { CollaborationProvider } from './providers/CollaborationProvider';
import { DocumentProvider } from './providers/DocumentProvider';
import { ThemeProvider } from './providers/ThemeProvider';

Toast.config({ duration: 2 });

function App() {
  useBrowserPageZoomGuard();

  return (
    <ConfigProvider locale={zhCN}>
      <ThemeProvider>
        <DocumentProvider>
          <CollaborationProvider>
            <AppShell />
          </CollaborationProvider>
        </DocumentProvider>
      </ThemeProvider>
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

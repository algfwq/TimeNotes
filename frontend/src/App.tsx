import { useEffect } from 'react';
import { ConfigProvider, Toast } from '@douyinfe/semi-ui';
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import { AppShell } from './components/AppShell';
import { CollaborationProvider } from './providers/CollaborationProvider';
import { DocumentProvider } from './providers/DocumentProvider';

Toast.config({ duration: 2 });

function App() {
  useBrowserPageZoomGuard();
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
        // 只取消浏览器默认页面缩放；事件仍继续传递，画布自己的 Ctrl+滚轮缩放不受影响。
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

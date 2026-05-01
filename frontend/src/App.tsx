import { ConfigProvider } from '@douyinfe/semi-ui';
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import { AppShell } from './components/AppShell';
import { CollaborationProvider } from './providers/CollaborationProvider';
import { DocumentProvider } from './providers/DocumentProvider';

function App() {
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

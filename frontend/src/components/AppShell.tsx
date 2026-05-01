import { Layout } from '@douyinfe/semi-ui';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { CanvasStage } from './CanvasStage';
import { FontFaceDefinitions } from './FontFaceDefinitions';
import { InspectorPanel } from './InspectorPanel';
import { LeftLibrary } from './LeftLibrary';
import { ReadOnlyViewer } from './ReadOnlyViewer';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { WorkspaceTabs } from './WorkspaceTabs';
import { useDocument } from '../providers/DocumentProvider';

export function AppShell() {
  const { activeTabMode, undo, redo, canUndo, canRedo } = useDocument();
  const { Header, Sider, Content, Footer } = Layout;
  const [leftWidth, setLeftWidth] = useState(306);
  const [rightWidth, setRightWidth] = useState(340);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if ((key === 'y' || (key === 'z' && event.shiftKey)) && canRedo) {
        event.preventDefault();
        redo();
      } else if (key === 'z' && canUndo) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canRedo, canUndo, redo, undo]);
  return (
    <Layout
      className="h-screen w-screen overflow-hidden bg-linen text-ink"
      style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) 48px' }}
    >
      <FontFaceDefinitions />
      <Header className="z-20 min-w-0 shrink-0 overflow-hidden border-b border-black/10 bg-white/88 backdrop-blur">
        <TopBar />
        <WorkspaceTabs />
      </Header>
      <Layout className="min-h-0 overflow-hidden">
        {activeTabMode === 'edit' ? (
          <>
            <Sider className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-black/10 bg-[#f8f4ea] max-md:w-[220px]" style={{ width: leftWidth }}>
              <LeftLibrary />
            </Sider>
            <ResizeHandle side="left" onResize={setLeftWidth} />
            <Content className="min-w-0 overflow-hidden">
              <CanvasStage />
            </Content>
            <ResizeHandle side="right" onResize={setRightWidth} />
            <Sider className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-black/10 bg-[#f8f4ea] max-lg:hidden" style={{ width: rightWidth }}>
              <InspectorPanel />
            </Sider>
          </>
        ) : (
          <Content className="min-w-0 overflow-hidden">
            <ReadOnlyViewer />
          </Content>
        )}
      </Layout>
      <Footer className="h-12 shrink-0 border-t border-black/10 bg-white/80 px-0 py-0">
        <StatusBar />
      </Footer>
    </Layout>
  );
}

function ResizeHandle({ side, onResize }: { side: 'left' | 'right'; onResize: Dispatch<SetStateAction<number>> }) {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    onResize((startWidth) => {
      const move = (moveEvent: PointerEvent) => {
        const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        onResize(Math.min(520, Math.max(220, startWidth + delta)));
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      return startWidth;
    });
  };

  return <div className="w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-[#2f6fed]/20" onPointerDown={startDrag} />;
}

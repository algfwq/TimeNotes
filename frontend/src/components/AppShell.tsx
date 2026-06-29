import { Layout } from '@douyinfe/semi-ui';
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { CanvasStage } from './CanvasStage';
import { FontFaceDefinitions } from './FontFaceDefinitions';
import { HomeWorkspace } from './HomeWorkspace';
import { InspectorPanel } from './InspectorPanel';
import { LeftLibrary } from './LeftLibrary';
import { ReadOnlyViewer } from './ReadOnlyViewer';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { WorkspaceTabs } from './WorkspaceTabs';
import { useDocument } from '../providers/DocumentProvider';
import * as NotebookService from '../../bindings/changeme/notebookservice';

function readDroppedFileAsBase64(file: File): Promise<{ base64: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      resolve({ base64, name: file.name });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function AppShell() {
  const { activeTabMode, undo, redo, canUndo, canRedo, openNotebookPath } = useDocument();
  const { Header, Sider, Content, Footer } = Layout;
  const [leftWidth, setLeftWidth] = useState(306);
  const [rightWidth, setRightWidth] = useState(340);
  const openNotebookPathRef = useRef(openNotebookPath);
  openNotebookPathRef.current = openNotebookPath;

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

  // 全局文件拖放监听（capture 阶段，参考 AssetLibrary 模式）。
  // WebView2 不暴露 File.path，因此通过 FileReader 读取文件二进制，
  // 调用 ImportNotebookFromData 写入临时位置后再打开。
  useEffect(() => {
    const handleDragOver = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      const hasNote = Array.from(files).some((f) => /\.tnote$/i.test(f.name));
      if (!hasNote) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };
    const handleDrop = async (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      const noteFile = Array.from(files).find((f) => /\.tnote$/i.test(f.name));
      if (!noteFile) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        const { base64, name } = await readDroppedFileAsBase64(noteFile);
        const meta = await NotebookService.ImportNotebookFromData(base64, name.replace(/\.tnote$/i, ''));
        await openNotebookPathRef.current(meta.path);
        Toast.success('已打开手账本');
      } catch (error) {
        Toast.error(`打开失败：${String(error)}`);
      }
    };
    window.addEventListener('dragover', handleDragOver, true);
    window.addEventListener('drop', handleDrop, true);
    return () => {
      window.removeEventListener('dragover', handleDragOver, true);
      window.removeEventListener('drop', handleDrop, true);
    };
  }, []);

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
        {activeTabMode === 'home' ? (
          <Content className="min-w-0 overflow-hidden">
            <HomeWorkspace />
          </Content>
        ) : activeTabMode === 'edit' ? (
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

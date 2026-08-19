import { Layout } from '@douyinfe/semi-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getShellLayout, isMobile, type ShellLayout } from '../lib/platform';
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

function useShellLayout(): ShellLayout {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return useMemo(() => {
    void tick;
    return getShellLayout();
  }, [tick]);
}

export function AppShell() {
  const { activeTabMode, undo, redo, canUndo, canRedo, openNotebookPath } = useDocument();
  const { Header, Sider, Content, Footer } = Layout;
  const shell = useShellLayout();
  const mobileHost = isMobile();

  const [leftWidth, setLeftWidth] = useState(() => getShellLayout().defaultLeft);
  const [rightWidth, setRightWidth] = useState(() => getShellLayout().defaultRight);
  const openNotebookPathRef = useRef(openNotebookPath);
  openNotebookPathRef.current = openNotebookPath;

  // 同步 document 布局 class：窄屏 compact，宽屏 full（大平板与桌面一致）
  useEffect(() => {
    if (!mobileHost) {
      document.documentElement.classList.remove('layout-compact', 'layout-full-mobile');
      return;
    }
    document.documentElement.classList.toggle('layout-compact', shell.compactChrome);
    document.documentElement.classList.toggle('layout-full-mobile', shell.mode === 'full');
  }, [mobileHost, shell.compactChrome, shell.mode]);

  // 视口变化时把侧栏夹到合法范围，但不强制改回 default（保留用户拖拽结果）
  useEffect(() => {
    setLeftWidth((w) => clamp(w, shell.minLeft, maxPanelWidth(shell, 'left', rightWidth)));
    setRightWidth((w) => clamp(w, shell.minRight, maxPanelWidth(shell, 'right', leftWidth)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随 shell 约束变化收敛
  }, [shell.width, shell.minLeft, shell.maxLeft, shell.minRight, shell.maxRight, shell.showInspector, shell.minCanvas]);

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

  const footerH = shell.compactChrome ? 40 : 48;
  const leftMax = maxPanelWidth(shell, 'left', shell.showInspector ? rightWidth : 0);
  const rightMax = maxPanelWidth(shell, 'right', leftWidth);
  const clampedLeft = clamp(leftWidth, shell.minLeft, leftMax);
  const clampedRight = clamp(rightWidth, shell.minRight, rightMax);

  return (
    <Layout
      className={`timenotes-shell overflow-hidden bg-linen text-ink ${mobileHost ? 'h-full w-full' : 'h-screen w-screen'}`}
      style={{ display: 'grid', gridTemplateRows: `auto minmax(0, 1fr) ${footerH}px` }}
    >
      <FontFaceDefinitions />
      <Header className="timenotes-chrome-header z-20 min-w-0 shrink-0 overflow-hidden border-b border-black/10 bg-white/88 backdrop-blur dark:border-white/[0.08] dark:bg-[#201e1c]/94">
        <TopBar compactChrome={shell.compactChrome} />
        <WorkspaceTabs />
      </Header>
      <Layout className="min-h-0 min-w-0 overflow-hidden">
        {activeTabMode === 'home' ? (
          <Content className="min-h-0 min-w-0 overflow-hidden">
            <HomeWorkspace />
          </Content>
        ) : activeTabMode === 'edit' ? (
          <>
            <Sider
              className="timenotes-chrome-sider flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-black/10 bg-[#f8f4ea] dark:border-white/[0.08] dark:bg-[#1e1c1a]"
              style={{ width: clampedLeft, minWidth: shell.minLeft }}
            >
              <LeftLibrary />
            </Sider>
            <ResizeHandle
              side="left"
              min={shell.minLeft}
              max={leftMax}
              onResize={setLeftWidth}
              touchFriendly={mobileHost}
            />
            <Content className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <CanvasStage />
            </Content>
            {shell.showInspector ? (
              <>
                <ResizeHandle
                  side="right"
                  min={shell.minRight}
                  max={rightMax}
                  onResize={setRightWidth}
                  touchFriendly={mobileHost}
                />
                <Sider
                  className="timenotes-chrome-sider flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-black/10 bg-[#f8f4ea] dark:border-white/[0.08] dark:bg-[#1e1c1a]"
                  style={{ width: clampedRight, minWidth: shell.minRight }}
                >
                  <InspectorPanel />
                </Sider>
              </>
            ) : null}
          </>
        ) : (
          <Content className="min-h-0 min-w-0 overflow-hidden">
            <ReadOnlyViewer />
          </Content>
        )}
      </Layout>
      <Footer className={`timenotes-chrome-footer shrink-0 border-t border-black/10 bg-white/80 px-0 py-0 dark:border-white/[0.08] dark:bg-[#201e1c]/94 ${shell.compactChrome ? 'h-10' : 'h-12'}`}>
        <StatusBar compactChrome={shell.compactChrome} />
      </Footer>
    </Layout>
  );
}

function maxPanelWidth(shell: ShellLayout, side: 'left' | 'right', otherPanelWidth: number): number {
  // edit 模式左侧始终在；右侧仅 showInspector 时占用宽度
  const occupiedOther = side === 'left' ? (shell.showInspector ? otherPanelWidth : 0) : otherPanelWidth;
  const byCanvas = shell.width - occupiedOther - shell.minCanvas - 24;
  const byCap = side === 'left' ? shell.maxLeft : shell.maxRight;
  const min = side === 'left' ? shell.minLeft : shell.minRight;
  return Math.max(min, Math.min(byCap, byCanvas));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ResizeHandle({
  side,
  min,
  max,
  onResize,
  touchFriendly,
}: {
  side: 'left' | 'right';
  min: number;
  max: number;
  onResize: Dispatch<SetStateAction<number>>;
  touchFriendly?: boolean;
}) {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    const startX = event.clientX;
    let baseWidth = 0;
    onResize((current) => {
      baseWidth = current;
      return current;
    });

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      onResize(clamp(Math.round(baseWidth + delta), min, max));
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // 触控端加宽命中条，桌面保持细条
  const hit = touchFriendly ? 'w-3' : 'w-1.5';
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖拽调整面板宽度"
      className={`${hit} shrink-0 cursor-col-resize touch-none bg-transparent hover:bg-[#2f6fed]/25 active:bg-[#2f6fed]/35 dark:hover:bg-white/10 dark:active:bg-white/16`}
      onPointerDown={startDrag}
    />
  );
}

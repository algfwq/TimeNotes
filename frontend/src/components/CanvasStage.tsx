import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Line } from 'react-konva';
import type Konva from 'konva';
import { IconArrowDown, IconArrowUp, IconCopy, IconCrop, IconDelete, IconEdit, IconImage } from '@douyinfe/semi-icons';
import { useDocument } from '../providers/DocumentProvider';
import { useCollaboration } from '../providers/CollaborationProvider';
import type { NoteElement, NotePage, PresenceUser } from '../types';
import { assetDataUrl, createAssetFromDataUrl, isGifAsset } from '../lib/files';
import { ImageCropModal } from './ImageCropModal';
import { PageBackground } from './PageBackground';
import { PageRenderer } from './PageRenderer';
import { SelectionController } from './SelectionController';

interface ContextMenuState {
  x: number;
  y: number;
  elementId: string;
}

// CanvasStage 负责纸张视口、缩放平移、自由绘制和右键菜单。
// DOM 层渲染文本/图片/贴纸等可编辑元素，Konva 只负责画笔、胶带和绘制中的草稿。
export function CanvasStage() {
  const { document, activePage, zoom, setZoom, tool, toolStyles, addElement, selectElement, stopEditing, placePendingElement } = useDocument();
  const { peers, updateCursor } = useCollaboration();
  const paperRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  // 远端光标是 presence 状态，不进入文档；这里节流后交给 CollaborationProvider 广播。
  const lastCursorAtRef = useRef(0);
  const cursorInsidePageRef = useRef(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [cropElementId, setCropElementId] = useState<string | null>(null);
  const elements = useMemo(
    () => document.elements.filter((element) => element.pageId === activePage.id),
    [activePage.id, document.elements],
  );
  const [draft, setDraft] = useState<{ type: 'drawing' | 'tape'; points: number[] } | null>(null);
  // draftRef 解决 Konva mouseup 和 React state 更新异步之间的竞态，确保结束绘制时拿到最新 points。
  const draftRef = useRef<{ type: 'drawing' | 'tape'; points: number[] } | null>(null);
  const isDrawingRef = useRef(false);

  const beginDrawing = (event: Konva.KonvaEventObject<MouseEvent>) => {
    // 只有画笔和胶带工具会让 Konva 接管鼠标事件，其他元素仍由 DOM/Moveable 处理。
    if (tool !== 'drawing' && tool !== 'tape') {
      return;
    }
    const position = getPagePoint(event, zoom);
    if (!position) {
      return;
    }
    event.evt.preventDefault();
    stopEditing();
    selectElement(undefined);
    isDrawingRef.current = true;
    const nextDraft = { type: tool, points: [position.x, position.y] };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  const continueDrawing = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (!isDrawingRef.current) {
      return;
    }
    const position = getPagePoint(event, zoom);
    if (!position) {
      return;
    }
    setDraft((current) => {
      const next = current
        ? {
            ...current,
            // 胶带笔用于贴出一条直线胶带，拖动过程中只保留起点和当前终点。
            points:
              current.type === 'tape'
                ? [current.points[0], current.points[1], position.x, position.y]
                : [...current.points, position.x, position.y],
          }
        : current;
      draftRef.current = next;
      return next;
    });
  };

  const endDrawing = () => {
    const currentDraft = draftRef.current;
    if (!isDrawingRef.current || !currentDraft) {
      return;
    }
    isDrawingRef.current = false;
    if (currentDraft.points.length > 3) {
      // 完成的笔迹保存为普通 NoteElement，坐标仍是页面坐标，便于导出和协作同步。
      const style = currentDraft.type === 'tape' ? { ...toolStyles.tape } : { ...toolStyles.drawing };
      addElement(currentDraft.type, {
        x: 0,
        y: 0,
        width: activePage.width,
        height: activePage.height,
        zIndex: Math.max(0, ...elements.map((element) => element.zIndex)) + 100,
        points: currentDraft.points,
        style,
      });
    }
    draftRef.current = null;
    setDraft(null);
  };

  const startPan = (event: React.MouseEvent) => {
    // 平移是纯视口状态，不写入文档；鼠标中键始终可临时拖拽画布。
    if (tool !== 'pan' && event.button !== 1) {
      return;
    }
    event.preventDefault();
    stopEditing();
    selectElement(undefined);
    panStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };

  const movePan = (event: React.MouseEvent) => {
    publishCursor(event);
    if (!panStartRef.current) {
      return;
    }
    const nextX = panStartRef.current.panX + event.clientX - panStartRef.current.x;
    const nextY = panStartRef.current.panY + event.clientY - panStartRef.current.y;
    setPan({ x: nextX, y: nextY });
  };

  const publishCursor = (event: React.MouseEvent) => {
    // 坐标发布前从屏幕坐标还原为页面坐标，远端不同缩放比例也能显示在同一纸张位置。
    const now = performance.now();
    const point = getDomPagePoint(event, paperRef.current, zoom);
    if (!point || point.x < 0 || point.y < 0 || point.x > activePage.width || point.y > activePage.height) {
      if (cursorInsidePageRef.current) {
        cursorInsidePageRef.current = false;
        lastCursorAtRef.current = now;
        updateCursor(undefined);
      }
      return;
    }
    if (now - lastCursorAtRef.current < 80) {
      return;
    }
    lastCursorAtRef.current = now;
    cursorInsidePageRef.current = true;
    updateCursor({ pageId: activePage.id, x: point.x, y: point.y });
  };

  const hideRemoteCursor = useCallback(() => {
    if (!cursorInsidePageRef.current) {
      return;
    }
    cursorInsidePageRef.current = false;
    updateCursor(undefined);
  }, [updateCursor]);

  const endPan = () => {
    panStartRef.current = null;
  };

  const handleWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const next = Math.min(2, Math.max(0.35, zoom + (event.deltaY > 0 ? -0.05 : 0.05)));
      setZoom(Number(next.toFixed(2)));
      return;
    }
    if (tool === 'pan') {
      event.preventDefault();
      setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
    }
  };

  const openElementContextMenu = useCallback((event: React.MouseEvent, element: NoteElement) => {
    setContextMenu({ x: event.clientX, y: event.clientY, elementId: element.id });
  }, []);

  const handlePaperMouseDown = (event: React.MouseEvent) => {
    // 点击已有元素时交给元素本身或 SelectionController，空白纸张才处理放置/取消选择。
    const target = event.target as HTMLElement;
    if (target.closest('[data-element-id]')) {
      return;
    }
    if (tool === 'text' || tool === 'code' || tool === 'sticker' || tool === 'image') {
      const point = getDomPagePoint(event, paperRef.current, zoom);
      if (point) {
        event.preventDefault();
        event.stopPropagation();
        stopEditing();
        selectElement(undefined);
        placePendingElement(point.x, point.y);
      }
      return;
    }
    if (tool !== 'pan') {
      selectElement(undefined);
      stopEditing();
    }
  };

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  useEffect(() => {
    hideRemoteCursor();
  }, [activePage.id, hideRemoteCursor]);

  return (
    <div
      ref={viewportRef}
      className={`relative h-full overflow-hidden bg-[#e8e2d6] ${
        tool === 'pan' ? 'cursor-grab' : tool === 'text' || tool === 'code' || tool === 'sticker' || tool === 'image' ? 'cursor-crosshair' : ''
      }`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          selectElement(undefined);
          stopEditing();
        }
        startPan(event);
      }}
      onMouseMove={movePan}
      onMouseUp={endPan}
      onMouseLeave={() => {
        endPan();
        hideRemoteCursor();
      }}
      onWheel={handleWheel}
    >
      <div
        className="absolute left-1/2 top-10"
        style={{ transform: `translate(-50%, 0) translate(${pan.x}px, ${pan.y}px)` }}
      >
        <div
          className="relative"
          style={{ width: activePage.width * zoom, height: activePage.height * zoom }}
          onMouseDown={handlePaperMouseDown}
        >
          <div
            ref={paperRef}
            className="absolute left-0 top-0 origin-top-left overflow-hidden shadow-page"
            style={{
              width: activePage.width,
              height: activePage.height,
              transform: `scale(${zoom})`,
              background: activePage.background,
            }}
            onMouseLeave={hideRemoteCursor}
          >
            {/* 背景图在所有元素下方，纸张纹理保持为轻量叠加层。 */}
            <PageBackground page={activePage} assets={document.assets} />
            <PaperTexture page={activePage} hasImage={Boolean(activePage.backgroundAssetId)} />
            {/* Konva 层覆盖整张纸，但只有绘制工具激活时才接收鼠标事件。 */}
            <DrawingLayer
              page={activePage}
              draft={draft}
              drawingEnabled={tool === 'drawing' || tool === 'tape'}
              draftStyle={draft?.type === 'tape' ? toolStyles.tape : toolStyles.drawing}
              onMouseDown={beginDrawing}
              onMouseMove={continueDrawing}
              onMouseUp={endDrawing}
            />
            <PageRenderer page={activePage} elements={elements} onElementContextMenu={openElementContextMenu} />
            {/* 远端选择框和光标始终在最上层展示，但 pointer-events 关闭，不影响本地编辑。 */}
            <RemoteCollaborationOverlay page={activePage} elements={elements} peers={peers} />
          </div>
          <SelectionController page={activePage} paperRef={paperRef} />
        </div>
      </div>
      <CanvasContextMenu state={contextMenu} onClose={() => setContextMenu(null)} onCrop={(id) => setCropElementId(id)} />
      <ElementCropModal elementId={cropElementId} onClose={() => setCropElementId(null)} />
    </div>
  );
}

function getPagePoint(event: Konva.KonvaEventObject<MouseEvent>, zoom: number) {
  const stage = event.target.getStage();
  const rect = stage?.container().getBoundingClientRect();
  if (!rect) {
    return null;
  }
  // Konva 不知道外层 DOM scale，这里把屏幕坐标换回持久化用的页面坐标。
  return {
    x: Math.max(0, Math.round((event.evt.clientX - rect.left) / zoom)),
    y: Math.max(0, Math.round((event.evt.clientY - rect.top) / zoom)),
  };
}

function getDomPagePoint(event: React.MouseEvent, paper: HTMLDivElement | null, zoom: number) {
  const rect = paper?.getBoundingClientRect();
  if (!rect) {
    return null;
  }
  return {
    x: Math.round((event.clientX - rect.left) / zoom),
    y: Math.round((event.clientY - rect.top) / zoom),
  };
}

// RemoteCollaborationOverlay 只渲染 presence，不修改本地文档；它依赖 peer.pageId/cursor.pageId 过滤当前页。
function RemoteCollaborationOverlay({ page, elements, peers }: { page: NotePage; elements: NoteElement[]; peers: PresenceUser[] }) {
  const activePeers = peers.filter((peer) => peer.pageId === page.id || peer.cursor?.pageId === page.id);
  if (activePeers.length === 0) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-[100000]" style={{ width: page.width, height: page.height }}>
      {activePeers.map((peer) => {
        const selected = peer.selectedElementId ? elements.find((element) => element.id === peer.selectedElementId) : undefined;
        return (
          <div key={peer.id}>
            {selected && selected.type !== 'drawing' && selected.type !== 'tape' ? (
              <div
                data-remote-selection-id={peer.id}
                className="absolute rounded-[6px] transition-[left,top,width,height,transform] duration-150"
                style={{
                  left: selected.x,
                  top: selected.y,
                  width: selected.width,
                  height: selected.height,
                  transform: `rotate(${selected.rotation}deg)`,
                  border: `2px dashed ${peer.color}`,
                  background: `${peer.color}12`,
                  boxShadow: `0 0 0 2px ${peer.color}22, 0 10px 24px rgba(0,0,0,.08)`,
                }}
              >
                {peer.editingElementId === selected.id ? (
                  <div className="absolute -right-2 -top-7 rounded-full px-2 py-1 text-[11px] font-medium text-white shadow" style={{ background: peer.color }}>
                    编辑中
                  </div>
                ) : null}
              </div>
            ) : null}
            {peer.cursor?.pageId === page.id ? (
              <div
                data-remote-cursor-id={peer.id}
                className="absolute transition-transform duration-100 ease-linear"
                style={{ transform: `translate3d(${peer.cursor.x}px, ${peer.cursor.y}px, 0)`, color: peer.color }}
              >
                <div
                  className="relative h-6 w-5"
                  style={{
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.25))',
                  }}
                >
                  <div
                    className="absolute left-0 top-0 h-6 w-5"
                    style={{
                      background: 'currentColor',
                      clipPath: 'polygon(0 0, 0 21px, 6px 15px, 10px 24px, 15px 22px, 11px 13px, 20px 13px)',
                    }}
                  />
                  <div
                    className="absolute left-[3px] top-[3px] h-[14px] w-[12px]"
                    style={{
                      background: 'rgba(255,255,255,.92)',
                      clipPath: 'polygon(0 0, 0 13px, 4px 9px, 7px 15px, 9px 14px, 6px 8px, 12px 8px)',
                    }}
                  />
                </div>
                <div
                  className="mt-1 max-w-36 translate-x-2 truncate rounded-full border border-white/70 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg"
                  style={{ background: peer.color }}
                >
                  {peer.name}
                  {peer.editingElementId ? <span className="ml-1 opacity-80">编辑中</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DrawingLayer({
  page,
  draft,
  drawingEnabled,
  draftStyle,
  onMouseDown,
  onMouseMove,
  onMouseUp,
}: {
  page: NotePage;
  draft: { type: 'drawing' | 'tape'; points: number[] } | null;
  drawingEnabled: boolean;
  draftStyle: Record<string, string | number | boolean>;
  onMouseDown: (event: Konva.KonvaEventObject<MouseEvent>) => void;
  onMouseMove: (event: Konva.KonvaEventObject<MouseEvent>) => void;
  onMouseUp: () => void;
}) {
  // Stage 的尺寸使用未缩放页面尺寸，外层 DOM scale 统一处理视觉缩放。
  return (
    <Stage
      className={`absolute inset-0 ${drawingEnabled ? 'z-[100500]' : 'z-[2]'}`}
      width={page.width}
      height={page.height}
      style={{ pointerEvents: drawingEnabled ? 'auto' : 'none' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <Layer>
        {draft ? <StrokeLine element={draftElement(page, draft, draftStyle)} selected={false} /> : null}
      </Layer>
    </Stage>
  );
}

function StrokeLine({ element, selected }: { element: NoteElement; selected: boolean }) {
  // 胶带复用 Line，但会叠加虚线、条纹或圆点装饰；画笔保持单条线。
  const points = element.points ?? [];
  const stroke = String(element.style?.stroke ?? (element.type === 'tape' ? '#f2cf72' : '#446f64'));
  const strokeWidth = Number(element.style?.strokeWidth ?? (element.type === 'tape' ? 22 : 6));
  const tapePattern = String(element.style?.tapePattern ?? 'dashes');
  if (element.type === 'tape') {
    return (
      <>
        {selected ? (
          <Line points={points} stroke="rgba(47,111,237,.32)" strokeWidth={strokeWidth + 10} tension={0.35} lineCap="round" lineJoin="round" />
        ) : null}
        <Line points={points} stroke={stroke} strokeWidth={strokeWidth} tension={0.35} lineCap="round" lineJoin="round" opacity={0.86} />
        {tapePattern === 'dashes' ? (
          <>
            <Line points={points} stroke="rgba(255,255,255,.72)" strokeWidth={3} tension={0.35} lineCap="round" lineJoin="round" dash={[2, 14]} />
            <Line points={points} stroke="rgba(120,80,40,.18)" strokeWidth={1.5} tension={0.35} lineCap="round" lineJoin="round" dash={[18, 10]} />
          </>
        ) : null}
        {tapePattern === 'stripe' ? (
          <Line points={points} stroke="rgba(255,255,255,.68)" strokeWidth={4} tension={0.35} lineCap="round" lineJoin="round" dash={[12, 10]} />
        ) : null}
        {tapePattern === 'dots' ? (
          <Line points={points} stroke="rgba(255,255,255,.82)" strokeWidth={5} tension={0.35} lineCap="round" lineJoin="round" dash={[1, 14]} />
        ) : null}
      </>
    );
  }
  return (
    <>
      {selected ? (
        <Line x={element.x} y={element.y} points={points} stroke="rgba(47,111,237,.28)" strokeWidth={strokeWidth + 10} tension={0.35} lineCap="round" lineJoin="round" />
      ) : null}
      <Line x={element.x} y={element.y} points={points} stroke={stroke} strokeWidth={strokeWidth} tension={0.35} lineCap="round" lineJoin="round" />
    </>
  );
}

function draftElement(page: NotePage, draft: { type: 'drawing' | 'tape'; points: number[] }, style: Record<string, string | number | boolean>): NoteElement {
  // 草稿元素只用于渲染，不写入 document；结束绘制后 addElement 才会生成真实 id。
  return {
    id: 'draft',
    pageId: page.id,
    type: draft.type,
    x: 0,
    y: 0,
    width: page.width,
    height: page.height,
    rotation: 0,
    zIndex: 0,
    points: draft.points,
    style,
  };
}

function CanvasContextMenu({ state, onClose, onCrop }: { state: ContextMenuState | null; onClose: () => void; onCrop: (id: string) => void }) {
  // 右键菜单直接操作当前元素模型；裁剪需要弹窗，先把目标 id 交给外层状态。
  const { document, updateElement, deleteElement, duplicateElement, moveElementLayer, startEditing } = useDocument();
  const element = state ? document.elements.find((item) => item.id === state.elementId) : undefined;
  if (!state || !element) {
    return null;
  }
  const style = element.style ?? {};
  const isMedia = element.type === 'image' || element.type === 'sticker';
  const mediaAsset = isMedia ? [...document.assets, ...document.stickers].find((asset) => asset.id === element.assetId) : undefined;
  const canCropMedia = Boolean(isMedia && mediaAsset && !isGifAsset(mediaAsset));
  const canDuplicate = element.type !== 'drawing' && element.type !== 'tape';
  return (
    <div
      className="fixed z-[900] min-w-40 rounded-[8px] border border-black/10 bg-white py-1 text-sm shadow-xl"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {element.type === 'text' || element.type === 'code' ? (
        <MenuButton
          icon={<IconEdit />}
          label={element.type === 'code' ? '编辑代码' : '编辑文字'}
          onClick={() => {
            startEditing(element.id);
            onClose();
          }}
        />
      ) : null}
      {isMedia ? (
        <>
          {canCropMedia ? (
            <MenuButton
              icon={<IconCrop />}
              label="裁剪图片"
              onClick={() => {
                onCrop(element.id);
                onClose();
              }}
            />
          ) : null}
          {style.fit === 'cover' ? (
            <MenuButton
              icon={<IconImage />}
              label="显示完整图片"
              onClick={() => {
                updateElement(element.id, { style: { ...style, fit: 'contain' } });
                onClose();
              }}
            />
          ) : null}
        </>
      ) : null}
      <MenuButton
        icon={<IconArrowUp />}
        label="上移一层"
        onClick={() => {
          moveElementLayer(element.id, 'up');
          onClose();
        }}
      />
      <MenuButton
        icon={<IconArrowDown />}
        label="下移一层"
        onClick={() => {
          moveElementLayer(element.id, 'down');
          onClose();
        }}
      />
      {canDuplicate ? (
        <MenuButton
          icon={<IconCopy />}
          label="复制"
          onClick={() => {
            duplicateElement(element.id);
            onClose();
          }}
        />
      ) : null}
      <div className="my-1 h-px bg-black/10" />
      <MenuButton
        danger
        icon={<IconDelete />}
        label="删除元素"
        onClick={() => {
          deleteElement(element.id);
          onClose();
        }}
      />
    </div>
  );
}

function ElementCropModal({ elementId, onClose }: { elementId: string | null; onClose: () => void }) {
  const { document, addAsset, updateElement } = useDocument();
  const element = elementId ? document.elements.find((item) => item.id === elementId) : undefined;
  const asset = element ? [...document.assets, ...document.stickers].find((item) => item.id === element.assetId) : undefined;
  const src = !isGifAsset(asset) ? assetDataUrl(asset) : undefined;
  const apply = async (dataUrl: string, size: { width: number; height: number; aspectRatio: number }) => {
    if (element && !isGifAsset(asset)) {
      const nextHeight = Math.max(1, Math.round(element.width / size.aspectRatio));
      if (element.type === 'sticker') {
        // 贴纸裁剪只影响当前画布元素，不写回贴纸库，避免“贴纸库”被裁剪结果污染。
        updateElement(element.id, {
          height: nextHeight,
          style: {
            ...(element.style ?? {}),
            fit: 'contain',
            cropDataUrl: dataUrl,
            cropX: 50,
            cropY: 50,
            objectPosition: '50% 50%',
            aspectRatio: size.aspectRatio,
          },
        });
      } else {
        const nextAsset = await createAssetFromDataUrl(dataUrl, `${asset?.name ?? '图片'}-裁剪.png`, 'assets', 'image/png');
        addAsset(nextAsset);
        updateElement(element.id, {
          assetId: nextAsset.id,
          style: {
            ...(element.style ?? {}),
            fit: 'contain',
            cropX: 50,
            cropY: 50,
            objectPosition: '50% 50%',
            aspectRatio: size.aspectRatio,
          },
          height: nextHeight,
        });
      }
    }
    onClose();
  };

  return (
    <ImageCropModal
      title="裁剪图片"
      visible={Boolean(element && src)}
      src={src}
      onClose={onClose}
      onApply={apply}
    />
  );
}

function MenuButton({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5 ${danger ? 'text-red-600' : 'text-[#2f2a24]'}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PaperTexture({ page, hasImage }: { page: NotePage; hasImage: boolean }) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        width: page.width,
        height: page.height,
        background:
          'radial-gradient(circle at 18% 22%, rgba(224,188,134,.18), transparent 26%), radial-gradient(circle at 78% 68%, rgba(126,160,150,.12), transparent 24%), linear-gradient(rgba(0,0,0,.035) 1px, transparent 1px)',
        backgroundSize: 'auto, auto, 100% 32px',
        mixBlendMode: 'multiply',
        opacity: hasImage ? 0.25 : 1,
      }}
    />
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Line } from 'react-konva';
import type Konva from 'konva';
import { IconArrowDown, IconArrowUp, IconCopy, IconCrop, IconDelete, IconEdit, IconImage } from '@douyinfe/semi-icons';
import { useDocument } from '../providers/DocumentProvider';
import type { NoteElement, NotePage } from '../types';
import { createAssetFromDataUrl } from '../lib/files';
import { ImageCropModal } from './ImageCropModal';
import { PageBackground } from './PageBackground';
import { PageRenderer } from './PageRenderer';
import { SelectionController } from './SelectionController';

interface ContextMenuState {
  x: number;
  y: number;
  elementId: string;
}

export function CanvasStage() {
  const { document, activePage, zoom, setZoom, tool, toolStyles, addElement, selectElement, stopEditing, placePendingElement } = useDocument();
  const paperRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [cropElementId, setCropElementId] = useState<string | null>(null);
  const elements = useMemo(
    () => document.elements.filter((element) => element.pageId === activePage.id),
    [activePage.id, document.elements],
  );
  const [draft, setDraft] = useState<{ type: 'drawing' | 'tape'; points: number[] } | null>(null);
  const draftRef = useRef<{ type: 'drawing' | 'tape'; points: number[] } | null>(null);
  const isDrawingRef = useRef(false);

  const beginDrawing = (event: Konva.KonvaEventObject<MouseEvent>) => {
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
    if (tool !== 'pan' && event.button !== 1) {
      return;
    }
    event.preventDefault();
    stopEditing();
    selectElement(undefined);
    panStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };

  const movePan = (event: React.MouseEvent) => {
    if (!panStartRef.current) {
      return;
    }
    const nextX = panStartRef.current.panX + event.clientX - panStartRef.current.x;
    const nextY = panStartRef.current.panY + event.clientY - panStartRef.current.y;
    setPan({ x: nextX, y: nextY });
  };

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
    const target = event.target as HTMLElement;
    if (target.closest('[data-element-id]')) {
      return;
    }
    if (tool === 'text' || tool === 'sticker' || tool === 'image') {
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

  return (
    <div
      ref={viewportRef}
      className={`relative h-full overflow-hidden bg-[#e8e2d6] ${
        tool === 'pan' ? 'cursor-grab' : tool === 'text' || tool === 'sticker' || tool === 'image' ? 'cursor-crosshair' : ''
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
      onMouseLeave={endPan}
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
          >
            {/* 背景图在所有元素下方，纸张纹理保持为轻量叠加层。 */}
            <PageBackground page={activePage} assets={document.assets} />
            <PaperTexture page={activePage} hasImage={Boolean(activePage.backgroundAssetId)} />
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
    x: Math.max(0, Math.round((event.clientX - rect.left) / zoom)),
    y: Math.max(0, Math.round((event.clientY - rect.top) / zoom)),
  };
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
  return (
    <Stage
      className={`absolute inset-0 ${drawingEnabled ? 'z-[60]' : 'z-[2]'}`}
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
  const { document, updateElement, deleteElement, duplicateElement, moveElementLayer, startEditing } = useDocument();
  const element = state ? document.elements.find((item) => item.id === state.elementId) : undefined;
  if (!state || !element) {
    return null;
  }
  const style = element.style ?? {};
  const isMedia = element.type === 'image' || element.type === 'sticker';
  const canDuplicate = element.type !== 'drawing' && element.type !== 'tape';
  return (
    <div
      className="fixed z-[900] min-w-40 rounded-[8px] border border-black/10 bg-white py-1 text-sm shadow-xl"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {element.type === 'text' ? (
        <MenuButton
          icon={<IconEdit />}
          label="编辑文字"
          onClick={() => {
            startEditing(element.id);
            onClose();
          }}
        />
      ) : null}
      {isMedia ? (
        <>
          <MenuButton
            icon={<IconCrop />}
            label="裁剪图片"
            onClick={() => {
              onCrop(element.id);
              onClose();
            }}
          />
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
  const src = asset?.dataUrl ?? (asset?.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);
  const apply = async (dataUrl: string, size: { width: number; height: number; aspectRatio: number }) => {
    if (element) {
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

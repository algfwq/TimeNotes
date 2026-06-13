import { useMemo } from 'react';
import { IconHandle } from '@douyinfe/semi-icons';
import { useDocument } from '../../providers/DocumentProvider';
import { resourceProgressKey, useResourceProgressMap } from '../../providers/ResourceProgressStore';
import type { AssetMeta, NoteDocument, NoteElement, ResourceTransferProgress } from '../../types';
import { assetDataUrl, isGifAsset, mergeAssetWithCache } from '../../lib/files';
import { AudioElement } from './AudioElement';
import { CodeBlockElement } from './CodeBlockElement';
import { ModelElement } from './ModelElement';
import { RichTextElement } from './RichTextElement';
import { VideoElement } from './VideoElement';

const directDragLiveSyncIntervalMs = 120;

export function ElementRenderer({
  element,
  onContextMenu,
}: {
  element: NoteElement;
  onContextMenu?: (event: React.MouseEvent, element: NoteElement) => void;
}) {
  const { document, activePage, selectedElementId, editingElementId, selectElement, startEditing, stopEditing, updateElement, zoom, tool, getResourceAsset } = useDocument();
  const resourceProgress = useResourceProgressMap();
  const selected = selectedElementId === element.id;
  const editing = editingElementId === element.id;
  const isStrokePath = (element.type === 'drawing' || element.type === 'tape') && Boolean(element.points?.length);
  const drawingToolActive = tool === 'drawing' || tool === 'tape';
  const documentAsset = useMemo(
    () => [...document.assets, ...document.stickers, ...document.audios, ...document.videos, ...document.models].find((item) => item.id === element.assetId),
    [document.assets, document.stickers, document.audios, document.videos, document.models, element.assetId],
  );
  const cachedAsset = getResourceAsset(element.assetId);
  const asset = useMemo(() => mergeAssetWithCache(documentAsset, cachedAsset), [cachedAsset, documentAsset]);
  const progress = element.assetId ? resourceProgress[resourceProgressKey(element.type === 'audio' ? 'audios' : element.type === 'video' ? 'videos' : element.type === 'model' ? 'models' : element.type === 'sticker' ? 'stickers' : 'assets', element.assetId)] : undefined;
  const baseStyle: React.CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${element.rotation}deg)`,
    zIndex: selected && isStrokePath ? 10000 + element.zIndex : element.zIndex,
    pointerEvents: isStrokePath || drawingToolActive ? 'none' : undefined,
  };

  return (
    <div
      data-element-id={element.id}
      data-page-id={element.pageId}
      data-type={element.type}
      data-editing={editing ? 'true' : 'false'}
      className="timenote-element absolute box-border select-none"
      style={baseStyle}
      onMouseDown={(event) => {
        if (tool === 'pan') {
          return;
        }
        event.stopPropagation();
        if (event.button !== 0) {
          return;
        }
        if (isAudioInteractiveTarget(event.target) || isVideoInteractiveTarget(event.target) || isModelInteractiveTarget(event.target)) {
          return;
        }
        selectElement(element.id);
        if (!selected && canDirectDragElement(element, tool)) {
          beginDirectElementDrag(event, {
            element,
            page: activePage,
            zoom,
            historyBase: document,
            updateElement,
          });
        }
        if (editing && element.type !== 'text' && element.type !== 'code') {
          stopEditing();
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        selectElement(element.id);
        if (element.type === 'text' || element.type === 'code') {
          startEditing(element.id);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        selectElement(element.id);
        onContextMenu?.(event, element);
      }}
    >
      {renderElement(element, selected, editing, asset, progress)}
      {selected && element.type === 'text' ? <TextMoveHandle element={element} page={activePage} zoom={zoom} onMove={updateElement} onBegin={() => stopEditing()} /> : null}
      {selected && element.type === 'model' ? <TextMoveHandle element={element} page={activePage} zoom={zoom} onMove={updateElement} onBegin={() => {}} /> : null}
    </div>
  );
}

function canDirectDragElement(element: NoteElement, tool: string) {
  if (tool !== 'select') {
    return false;
  }
  if (element.type === 'model') {
    return false;
  }
  return !((element.type === 'drawing' || element.type === 'tape') && Boolean(element.points?.length));
}

function isAudioInteractiveTarget(target: EventTarget) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-audio-interactive]'));
}

function isVideoInteractiveTarget(target: EventTarget) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-video-interactive]'));
}

function isModelInteractiveTarget(target: EventTarget) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-model-interactive]'));
}

function beginDirectElementDrag(
  event: React.MouseEvent<HTMLDivElement>,
  {
    element,
    page,
    zoom,
    historyBase,
    updateElement,
  }: {
    element: NoteElement;
    page: { width: number; height: number };
    zoom: number;
    historyBase: NoteDocument;
    updateElement: (id: string, patch: Partial<NoteElement>, options?: { history?: boolean; historyBase?: NoteDocument }) => void;
  },
) {
  event.preventDefault();
  const target = event.currentTarget;
  const start = { x: event.clientX, y: event.clientY, elementX: element.x, elementY: element.y };
  let moved = false;
  let liveTimer: number | undefined;
  let lastLiveAt = 0;
  let pendingPosition: { x: number; y: number } | null = null;
  let nextPosition = { x: element.x, y: element.y };

  const flushLive = () => {
    if (!pendingPosition) {
      return;
    }
    const patch = pendingPosition;
    pendingPosition = null;
    lastLiveAt = performance.now();
    updateElement(element.id, patch, { history: false });
  };

  const move = (moveEvent: MouseEvent) => {
    const deltaX = moveEvent.clientX - start.x;
    const deltaY = moveEvent.clientY - start.y;
    if (!moved && Math.hypot(deltaX, deltaY) < 3) {
      return;
    }
    moved = true;
    nextPosition = {
      x: clamp(Math.round(start.elementX + deltaX / zoom), 0, Math.max(0, page.width - element.width)),
      y: clamp(Math.round(start.elementY + deltaY / zoom), 0, Math.max(0, page.height - element.height)),
    };
    target.style.left = `${nextPosition.x}px`;
    target.style.top = `${nextPosition.y}px`;
    pendingPosition = nextPosition;
    const elapsed = performance.now() - lastLiveAt;
    if (elapsed >= directDragLiveSyncIntervalMs) {
      if (liveTimer) {
        window.clearTimeout(liveTimer);
        liveTimer = undefined;
      }
      flushLive();
      return;
    }
    if (!liveTimer) {
      liveTimer = window.setTimeout(() => {
        liveTimer = undefined;
        flushLive();
      }, directDragLiveSyncIntervalMs - elapsed);
    }
  };

  const end = () => {
    if (liveTimer) {
      window.clearTimeout(liveTimer);
      liveTimer = undefined;
    }
    pendingPosition = null;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', end);
    if (moved && (nextPosition.x !== element.x || nextPosition.y !== element.y)) {
      updateElement(element.id, nextPosition, { historyBase });
    }
  };

  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
}

function TextMoveHandle({
  element,
  page,
  zoom,
  onMove,
  onBegin,
}: {
  element: NoteElement;
  page: { width: number; height: number };
  zoom: number;
  onMove: (id: string, patch: Partial<NoteElement>) => void;
  onBegin: () => void;
}) {
  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onBegin();
    const start = { x: event.clientX, y: event.clientY, elementX: element.x, elementY: element.y };
    const target = event.currentTarget.closest<HTMLElement>('[data-element-id]');
    let nextPosition = { x: element.x, y: element.y };
    let lastMoveableUpdate = 0;
    const moveableUpdateIntervalMs = 32;
    const move = (moveEvent: PointerEvent) => {
      nextPosition = {
        x: clamp(Math.round(start.elementX + (moveEvent.clientX - start.x) / zoom), 0, Math.max(0, page.width - element.width)),
        y: clamp(Math.round(start.elementY + (moveEvent.clientY - start.y) / zoom), 0, Math.max(0, page.height - element.height)),
      };
      if (target) {
        target.style.left = `${nextPosition.x}px`;
        target.style.top = `${nextPosition.y}px`;
      }
      const now = performance.now();
      if (now - lastMoveableUpdate >= moveableUpdateIntervalMs) {
        lastMoveableUpdate = now;
        window.dispatchEvent(new CustomEvent('timenotes-moveable-update'));
      }
    };
    const end = () => {
      if (nextPosition.x !== element.x || nextPosition.y !== element.y) {
        onMove(element.id, nextPosition);
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  return (
    <button
      type="button"
      title="拖拽移动文字"
      className="absolute -left-3 -top-3 z-20 grid h-7 w-7 cursor-grab place-items-center rounded-full border border-[#2f6fed] bg-white text-[#2f6fed] shadow-sm active:cursor-grabbing"
      onPointerDown={beginDrag}
    >
      <IconHandle />
    </button>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function renderElement(element: NoteElement, selected: boolean, editing: boolean, asset?: AssetMeta, progress?: ResourceTransferProgress) {
  const style = element.style ?? {};
  if (element.type === 'text') {
    return <RichTextElement element={element} selected={selected} editing={editing} />;
  }
  if (element.type === 'code') {
    return <CodeBlockElement element={element} selected={selected} editing={editing} />;
  }
  if (element.type === 'audio') {
    return <AudioElement element={element} asset={asset} progress={progress} />;
  }
  if (element.type === 'video') {
    return <VideoElement element={element} asset={asset} progress={progress} />;
  }
  if (element.type === 'model') {
    return <ModelElement element={element} asset={asset} progress={progress} />;
  }
  if ((element.type === 'drawing' || element.type === 'tape') && element.points?.length) {
    return <StrokeSvg element={element} selected={selected} />;
  }
  if (element.type === 'image' || element.type === 'sticker') {
    // 贴纸裁剪结果是元素级显示数据，不能反向污染全局贴纸库。
    const elementCropDataUrl =
      element.type === 'sticker' && !isGifAsset(asset) && typeof style.cropDataUrl === 'string' && style.cropDataUrl.startsWith('data:')
        ? style.cropDataUrl
        : undefined;
    const dataUrl = elementCropDataUrl ?? assetDataUrl(asset);
    const showFrame = style.showFrame !== false;
    if (dataUrl) {
      return (
        <img
          className={`h-full w-full ${showFrame ? 'rounded-[8px]' : ''} ${showFrame ? (element.type === 'sticker' ? 'drop-shadow-md' : 'shadow-md') : ''}`}
          src={dataUrl}
          alt=""
          draggable={false}
          style={{
            objectFit: String(style.fit ?? 'contain') as React.CSSProperties['objectFit'],
            objectPosition: objectPosition(style),
          }}
        />
      );
    }
    if (progress) {
      return <ResourceProgressPlaceholder name={asset?.name ?? '素材'} progress={progress.progress} />;
    }
    if (element.type === 'sticker') {
      return (
        <div
          className="grid h-full w-full place-items-center drop-shadow-md"
          style={{ fontSize: Number(style.fontSize ?? 72) }}
        >
          {element.content ?? '贴纸'}
        </div>
      );
    }
    return (
      <div
        className={`h-full w-full ${showFrame ? 'rounded-[8px] shadow-md' : ''}`}
        style={{ background: String(style.background ?? 'linear-gradient(135deg,#f4b4a4,#8ab6d6)') }}
      />
    );
  }
  if (element.type === 'tape') {
    return (
      <div
        className="h-full w-full rounded-[4px] opacity-80 shadow-sm"
        style={{
          background: String(style.background ?? '#f7d774'),
          borderTop: '1px solid rgba(255,255,255,.55)',
          borderBottom: '1px solid rgba(0,0,0,.08)',
        }}
      />
    );
  }
  return (
    <div
      className="h-full w-full rounded-[8px] border-2"
      style={{ borderColor: String(style.stroke ?? '#2f2a24'), background: String(style.background ?? 'transparent') }}
    />
  );
}

function ResourceProgressPlaceholder({ name, progress }: { name: string; progress: number }) {
  return (
    <div className="grid h-full w-full place-items-center rounded-[8px] border border-dashed border-black/15 bg-white/70 px-3 text-center">
      <div className="w-full">
        <div className="truncate text-xs text-black/55">{name}</div>
        <div className="mt-1 text-[11px] text-black/45">素材传输中</div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
          <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="mt-1 text-[11px] text-black/45">{Math.round(progress * 100)}%</div>
      </div>
    </div>
  );
}

function StrokeSvg({ element, selected }: { element: NoteElement; selected: boolean }) {
  const style = element.style ?? {};
  const stroke = String(style.stroke ?? (element.type === 'tape' ? '#f2cf72' : '#446f64'));
  const strokeWidth = Number(style.strokeWidth ?? (element.type === 'tape' ? 22 : 6));
  const tapePattern = String(style.tapePattern ?? 'dashes');
  const polyline = pointsToPolyline(element.points ?? []);
  return (
    <svg className="pointer-events-none absolute inset-0 overflow-visible" width={element.width} height={element.height}>
      {selected ? (
        <polyline
          points={polyline}
          fill="none"
          stroke="rgba(47,111,237,.28)"
          strokeWidth={strokeWidth + 10}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      <polyline
        points={polyline}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={element.type === 'tape' ? 0.86 : 1}
      />
      {element.type === 'tape' && tapePattern === 'dashes' ? (
        <>
          <polyline
            points={polyline}
            fill="none"
            stroke="rgba(255,255,255,.72)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="2 14"
          />
          <polyline
            points={polyline}
            fill="none"
            stroke="rgba(120,80,40,.18)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="18 10"
          />
        </>
      ) : null}
      {element.type === 'tape' && tapePattern === 'stripe' ? (
        <polyline
          points={polyline}
          fill="none"
          stroke="rgba(255,255,255,.68)"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="12 10"
        />
      ) : null}
      {element.type === 'tape' && tapePattern === 'dots' ? (
        <polyline
          points={polyline}
          fill="none"
          stroke="rgba(255,255,255,.82)"
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="1 14"
        />
      ) : null}
    </svg>
  );
}

function pointsToPolyline(points: number[], offsetX = 0, offsetY = 0) {
  const values: string[] = [];
  for (let index = 0; index < points.length - 1; index += 2) {
    values.push(`${points[index] + offsetX},${points[index + 1] + offsetY}`);
  }
  return values.join(' ');
}

function objectPosition(style: Record<string, string | number | boolean>) {
  if (style.objectPosition) {
    return String(style.objectPosition);
  }
  if (style.cropX !== undefined || style.cropY !== undefined) {
    return `${Number(style.cropX ?? 50)}% ${Number(style.cropY ?? 50)}%`;
  }
  return '50% 50%';
}

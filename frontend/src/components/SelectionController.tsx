import { useEffect, useMemo, useRef, useState } from 'react';
import Moveable from 'react-moveable';
import { isMobile } from '../lib/platform';
import { useDocument } from '../providers/DocumentProvider';
import type { NoteElement, NotePage } from '../types';

interface AlignmentGuide {
  axis: 'x' | 'y';
  position: number;
}

interface SnapReferences {
  vertical: number[];
  horizontal: number[];
}

interface SnapMatch {
  delta: number;
  position: number;
  distance: number;
}

const snapThreshold = 10;
const liveElementSyncIntervalMs = 120;

/** 仅移动端：命中视频/音频/3D 内部操作控件时，Moveable 不应启动拖拽/缩放。 */
function isElementChromeControl(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest(
      [
        'button',
        'input',
        'select',
        'textarea',
        'a',
        '[role="button"]',
        '[role="slider"]',
        '[contenteditable="true"]',
        '[data-video-interactive]',
        '[data-audio-interactive]',
        '[data-model-interactive] button',
        '[data-video-player] button',
        '[data-video-player] input',
        '[data-video-player] [role="button"]',
        '[data-video-player] [role="slider"]',
        '.semi-videoPlayer-controls',
        '.semi-videoPlayer-controls-menu',
        '.semi-slider',
        '.timenotes-audio-player button',
        '.timenotes-audio-player input',
        '.timenotes-audio-player [role="slider"]',
        '[data-element-move-handle]',
      ].join(', '),
    ),
  );
}

// SelectionController 把 DOM 元素绑定到 Moveable，负责拖拽、缩放、旋转和对齐参考线。
// 它只处理非绘制类元素；画笔和胶带由 Konva 层单独渲染与选择。
export function SelectionController({
  page,
  paperRef,
}: {
  page: NotePage;
  paperRef: React.RefObject<HTMLDivElement>;
}) {
  const { document: noteDocument, selectedElement, selectedElementId, editingElementId, updateElement, zoom } = useDocument();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [blockedByModal, setBlockedByModal] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [elementGuidelines, setElementGuidelines] = useState<HTMLElement[]>([]);
  const [visibleGuides, setVisibleGuides] = useState<AlignmentGuide[]>([]);
  const moveableRef = useRef<any>(null);
  const pendingPatchRef = useRef<Partial<NoteElement> | null>(null);
  // pendingLivePatchRef 用于协作实时预览；pendingPatchRef 保存交互结束时需要写入历史的最终值。
  const pendingLivePatchRef = useRef<Partial<NoteElement> | null>(null);
  const livePatchTimerRef = useRef<number | undefined>();
  const lastLivePatchAtRef = useRef(0);
  const interactionStartDocumentRef = useRef(noteDocument);
  const editing = Boolean(selectedElementId && selectedElementId === editingElementId);
  const keepRatio = selectedElement?.type === 'image' || selectedElement?.type === 'sticker' || selectedElement?.type === 'video';
  const isModel = selectedElement?.type === 'model';
  const isVideo = selectedElement?.type === 'video';
  const isAudio = selectedElement?.type === 'audio';
  // 音视频/3D 本体拖拽由 ElementRenderer 直拖（避开控件）；Moveable 只负责缩放/旋转手柄，避免盖住播放按钮。
  const mobile = isMobile();
  const allowDrag = !editing && !isModel && !(mobile && (isVideo || isAudio));
  const allowTransform = !editing;
  const minSize = selectedElement?.type === 'audio' ? { width: 46, height: 46 } : selectedElement?.type === 'video' ? { width: 160, height: 90 } : { width: 1, height: 1 };
  const elementRatio = Number(selectedElement?.style?.aspectRatio ?? 0) || (selectedElement ? selectedElement.width / Math.max(1, selectedElement.height) : 1);
  const snapReferences = useMemo(
    // 对齐参考点来自页面边缘/中心和同页其他元素的边缘/中心，坐标都是页面坐标。
    () => createSnapReferences(noteDocument.elements, page, selectedElementId),
    [noteDocument.elements, page, selectedElementId],
  );

  useEffect(() => {
    // 选中元素的 DOM 节点可能因为 React 重渲染被替换，因此每次 selectedElement 变化都重新查找 target。
    if (!selectedElementId) {
      setTarget(null);
      return;
    }
    setTarget(document.querySelector<HTMLElement>(`[data-element-id="${selectedElementId}"]`));
  }, [selectedElementId, selectedElement]);

  useEffect(() => {
    // 缩放或元素样式更新后，Moveable 的控制框需要下一帧重新测量 DOM rect。
    const frame = window.requestAnimationFrame(() => moveableRef.current?.updateRect?.());
    return () => window.cancelAnimationFrame(frame);
  }, [selectedElement, target, zoom]);

  useEffect(() => {
    const handle = () => {
      moveableRef.current?.updateRect?.();
    };
    window.addEventListener('timenotes-moveable-update', handle);
    return () => window.removeEventListener('timenotes-moveable-update', handle);
  }, []);

  useEffect(() => {
    return () => {
      if (livePatchTimerRef.current) {
        window.clearTimeout(livePatchTimerRef.current);
      }
    };
  }, []);

  const beginElementInteraction = () => {
    // 记录交互开始时的文档快照，让一次拖拽只产生一条可撤销历史，而不是每帧一条。
    if (livePatchTimerRef.current) {
      window.clearTimeout(livePatchTimerRef.current);
      livePatchTimerRef.current = undefined;
    }
    interactionStartDocumentRef.current = noteDocument;
    pendingPatchRef.current = null;
    pendingLivePatchRef.current = null;
    lastLivePatchAtRef.current = 0;
    setInteracting(true);
    setVisibleGuides([]);
  };

  const flushLivePatch = () => {
    // 交互中的轻量 patch 不写历史，只让本机 UI 和协作者能看到实时位置。
    if (!selectedElement || !pendingLivePatchRef.current) {
      return;
    }
    const patch = pendingLivePatchRef.current;
    pendingLivePatchRef.current = null;
    lastLivePatchAtRef.current = performance.now();
    updateElement(selectedElement.id, patch, { history: false });
  };

  const queueLivePatch = (patch: Partial<NoteElement>) => {
    // Moveable 事件可能每帧触发，节流后再写 DocumentProvider，降低 React/Yjs 压力。
    pendingPatchRef.current = patch;
    pendingLivePatchRef.current = patch;
    const elapsed = performance.now() - lastLivePatchAtRef.current;
    if (elapsed >= liveElementSyncIntervalMs) {
      if (livePatchTimerRef.current) {
        window.clearTimeout(livePatchTimerRef.current);
        livePatchTimerRef.current = undefined;
      }
      flushLivePatch();
      return;
    }
    if (!livePatchTimerRef.current) {
      livePatchTimerRef.current = window.setTimeout(() => {
        livePatchTimerRef.current = undefined;
        flushLivePatch();
      }, liveElementSyncIntervalMs - elapsed);
    }
  };

  const finishElementInteraction = () => {
    // 松手时写入最终 patch，并用交互开始前的文档作为 historyBase。
    setInteracting(false);
    setVisibleGuides([]);
    if (livePatchTimerRef.current) {
      window.clearTimeout(livePatchTimerRef.current);
      livePatchTimerRef.current = undefined;
    }
    const finalPatch = pendingPatchRef.current;
    pendingPatchRef.current = null;
    pendingLivePatchRef.current = null;
    if (selectedElement && finalPatch) {
      updateElement(selectedElement.id, finalPatch, { historyBase: interactionStartDocumentRef.current });
    }
  };

  useEffect(() => {
    // react-moveable 的 elementGuidelines 需要真实 DOM 节点，延后一帧等元素渲染完成再收集。
    const frame = window.requestAnimationFrame(() => {
      const nodes = Array.from(globalThis.document.querySelectorAll<HTMLElement>('[data-element-id]')).filter((node) => {
        const elementId = node.dataset.elementId;
        const element = noteDocument.elements.find((item) => item.id === elementId);
        return Boolean(element && element.pageId === page.id && element.id !== selectedElementId && element.type !== 'drawing' && element.type !== 'tape');
      });
      setElementGuidelines(nodes);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [noteDocument.elements, page.id, selectedElementId, zoom]);

  useEffect(() => {
    // Semi 弹窗打开时暂时禁用 Moveable，避免弹窗上方仍出现选择框或拖拽手柄。
    const refresh = () => {
      const visibleModal = Array.from(document.querySelectorAll<HTMLElement>('.semi-modal, .semi-modal-mask')).some(
        (node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && (rect.width > 0 || rect.height > 0);
        },
      );
      setBlockedByModal(visibleModal);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!selectedElement || !target || selectedElement.type === 'drawing' || (selectedElement.type === 'tape' && selectedElement.points?.length) || blockedByModal) {
    return null;
  }

  return (
    <>
      <AlignmentGuideOverlay page={page} zoom={zoom} guides={visibleGuides} />
      <Moveable
        key={`${selectedElement.id}-${zoom}`}
        ref={moveableRef}
        target={target}
        container={paperRef.current?.parentElement ?? undefined}
        zoom={zoom}
        origin={false}
        // 移动端专用 class：放大命中区域；桌面不挂 class，保持原样式
        className={mobile ? 'timenotes-moveable-mobile' : undefined}
        {...(mobile
          ? {
              // 仅触控端：更大手柄命中区；checkInput 放行 input/textarea
              linePadding: 20,
              controlPadding: 22,
              pinchable: false as const,
              checkInput: true,
              // 阻止 Moveable 吞掉子控件 click
              preventClickEventOnDrag: true,
            }
          : {})}
        draggable={allowDrag}
        resizable={allowTransform}
        rotatable={allowTransform}
        snappable={interacting}
        snapThreshold={snapThreshold}
        snapRenderThreshold={snapThreshold}
        isDisplaySnapDigit={false}
        keepRatio={keepRatio}
        bounds={{ left: 0, top: 0, right: page.width, bottom: page.height }}
        horizontalGuidelines={[0, page.height / 2, page.height]}
        verticalGuidelines={[0, page.width / 2, page.width]}
        elementGuidelines={elementGuidelines}
        snapDirections={{ left: true, right: true, top: true, bottom: true, center: true, middle: true }}
        elementSnapDirections={{ left: true, right: true, top: true, bottom: true, center: true, middle: true }}
        onDragStart={(e: any) => {
          // 仅移动端拦截控件命中；桌面保持 Moveable 原有拖拽判定。
          if (mobile && isElementChromeControl(e.inputEvent?.target)) {
            e.stop();
            return;
          }
          if (mobile) {
            e.inputEvent?.stopPropagation?.();
          }
          beginElementInteraction();
        }}
        onDrag={({ target: dragTarget, left, top }: any) => {
          const clamped = clampBox({ x: left, y: top, width: selectedElement.width, height: selectedElement.height }, page, undefined, minSize);
          const snapped = snapBox(clamped, snapReferences, page);
          dragTarget.style.left = `${snapped.box.x}px`;
          dragTarget.style.top = `${snapped.box.y}px`;
          setVisibleGuides(snapped.guides);
          queueLivePatch({ x: snapped.box.x, y: snapped.box.y });
        }}
        onResizeStart={(e: any) => {
          if (mobile && isElementChromeControl(e.inputEvent?.target)) {
            e.stop();
            return;
          }
          if (mobile) {
            e.inputEvent?.stopPropagation?.();
          }
          beginElementInteraction();
        }}
        onResize={({ target: resizeTarget, width, height, drag }: any) => {
          const clamped = clampBox({ x: drag.left, y: drag.top, width, height }, page, keepRatio ? elementRatio : undefined, minSize);
          const snapped = snapBox(clamped, snapReferences, page);
          resizeTarget.style.width = `${snapped.box.width}px`;
          resizeTarget.style.height = `${snapped.box.height}px`;
          resizeTarget.style.left = `${snapped.box.x}px`;
          resizeTarget.style.top = `${snapped.box.y}px`;
          setVisibleGuides(snapped.guides);
          queueLivePatch({
            width: snapped.box.width,
            height: snapped.box.height,
            x: snapped.box.x,
            y: snapped.box.y,
          });
        }}
        onRotateStart={(e: any) => {
          if (mobile && isElementChromeControl(e.inputEvent?.target)) {
            e.stop();
            return;
          }
          if (mobile) {
            e.inputEvent?.stopPropagation?.();
          }
          beginElementInteraction();
        }}
        onRotate={({ target: rotateTarget, rotate }: any) => {
          rotateTarget.style.transform = `rotate(${rotate}deg)`;
          queueLivePatch({ rotation: Math.round(rotate) });
        }}
        onDragEnd={finishElementInteraction}
        onResizeEnd={finishElementInteraction}
        onRotateEnd={finishElementInteraction}
      />
    </>
  );
}

function AlignmentGuideOverlay({ page, zoom, guides }: { page: NotePage; zoom: number; guides: AlignmentGuide[] }) {
  // 自定义参考线覆盖在纸张外层，按 zoom 放大视觉位置，但持久坐标仍保持页面坐标。
  if (guides.length === 0) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[35]" style={{ width: page.width * zoom, height: page.height * zoom }}>
      {dedupeGuides(guides).map((guide) =>
        guide.axis === 'x' ? (
          <div
            key={`x-${guide.position}`}
            className="timenotes-alignment-guide timenotes-alignment-guide-x absolute top-0"
            style={{ left: guide.position * zoom, width: 0, height: page.height * zoom }}
          />
        ) : (
          <div
            key={`y-${guide.position}`}
            className="timenotes-alignment-guide timenotes-alignment-guide-y absolute left-0"
            style={{ top: guide.position * zoom, width: page.width * zoom, height: 0 }}
          />
        ),
      )}
    </div>
  );
}

function createSnapReferences(elements: NoteElement[], page: NotePage, selectedElementId?: string): SnapReferences {
  // 自由绘制和胶带没有稳定矩形边界，不参与吸附参考点。
  const vertical = [0, page.width / 2, page.width];
  const horizontal = [0, page.height / 2, page.height];
  elements.forEach((element) => {
    if (element.pageId !== page.id || element.id === selectedElementId || element.type === 'drawing' || element.type === 'tape') {
      return;
    }
    vertical.push(element.x, element.x + element.width / 2, element.x + element.width);
    horizontal.push(element.y, element.y + element.height / 2, element.y + element.height);
  });
  return {
    vertical: dedupeNumbers(vertical),
    horizontal: dedupeNumbers(horizontal),
  };
}

function snapBox(box: { x: number; y: number; width: number; height: number }, references: SnapReferences, page: NotePage) {
  // 先对 x/y 分别找最近参考点，再统一 clamp，确保吸附后不会越出页面。
  const guides: AlignmentGuide[] = [];
  const xSnap = findBestSnap([box.x, box.x + box.width / 2, box.x + box.width], references.vertical);
  const ySnap = findBestSnap([box.y, box.y + box.height / 2, box.y + box.height], references.horizontal);
  let nextBox = { ...box };
  if (xSnap) {
    nextBox.x += xSnap.delta;
  }
  if (ySnap) {
    nextBox.y += ySnap.delta;
  }
  nextBox = clampBox(nextBox, page);
  if (xSnap && Math.abs(nextBox.x - (box.x + xSnap.delta)) <= 1) {
    guides.push({ axis: 'x', position: xSnap.position });
  }
  if (ySnap && Math.abs(nextBox.y - (box.y + ySnap.delta)) <= 1) {
    guides.push({ axis: 'y', position: ySnap.position });
  }
  return { box: nextBox, guides };
}

function findBestSnap(currentPositions: number[], targetPositions: number[]): SnapMatch | null {
  let best: SnapMatch | null = null;
  for (const current of currentPositions) {
    for (const target of targetPositions) {
      const delta = target - current;
      const distance = Math.abs(delta);
      if (distance <= snapThreshold && (!best || distance < best.distance)) {
        best = { delta, position: target, distance };
      }
    }
  }
  return best;
}

function dedupeNumbers(values: number[]) {
  return Array.from(new Set(values.map((value) => Math.round(value))));
}

function dedupeGuides(guides: AlignmentGuide[]) {
  const seen = new Set<string>();
  return guides.filter((guide) => {
    const key = `${guide.axis}-${Math.round(guide.position)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function clampBox(
  box: { x: number; y: number; width: number; height: number },
  page: NotePage,
  aspectRatio?: number,
  minSize: { width: number; height: number } = { width: 1, height: 1 },
) {
  let width = Math.max(minSize.width, Math.round(box.width));
  let height = Math.max(minSize.height, Math.round(box.height));
  if (aspectRatio && aspectRatio > 0) {
    height = Math.max(minSize.height, Math.round(width / aspectRatio));
    if (height > page.height) {
      height = page.height;
      width = Math.max(minSize.width, Math.round(height * aspectRatio));
    }
  }
  width = Math.min(width, page.width);
  height = Math.min(height, page.height);
  const x = Math.min(Math.max(0, Math.round(box.x)), Math.max(0, page.width - width));
  const y = Math.min(Math.max(0, Math.round(box.y)), Math.max(0, page.height - height));
  return { x, y, width, height };
}

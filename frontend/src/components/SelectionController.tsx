import { useEffect, useMemo, useRef, useState } from 'react';
import Moveable from 'react-moveable';
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
  const editing = Boolean(selectedElementId && selectedElementId === editingElementId);
  const keepRatio = selectedElement?.type === 'image' || selectedElement?.type === 'sticker';
  const elementRatio = Number(selectedElement?.style?.aspectRatio ?? 0) || (selectedElement ? selectedElement.width / Math.max(1, selectedElement.height) : 1);
  const snapReferences = useMemo(
    () => createSnapReferences(noteDocument.elements, page, selectedElementId),
    [noteDocument.elements, page, selectedElementId],
  );

  useEffect(() => {
    if (!selectedElementId) {
      setTarget(null);
      return;
    }
    setTarget(document.querySelector<HTMLElement>(`[data-element-id="${selectedElementId}"]`));
  }, [selectedElementId, selectedElement]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => moveableRef.current?.updateRect?.());
    return () => window.cancelAnimationFrame(frame);
  }, [selectedElement, target, zoom]);

  useEffect(() => {
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
        draggable={!editing}
        resizable={!editing}
        rotatable={!editing}
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
        onDragStart={() => {
          setInteracting(true);
          setVisibleGuides([]);
        }}
        onDrag={({ target: dragTarget, left, top }: any) => {
          const clamped = clampBox({ x: left, y: top, width: selectedElement.width, height: selectedElement.height }, page);
          const snapped = snapBox(clamped, snapReferences, page);
          dragTarget.style.left = `${snapped.box.x}px`;
          dragTarget.style.top = `${snapped.box.y}px`;
          setVisibleGuides(snapped.guides);
          pendingPatchRef.current = { x: snapped.box.x, y: snapped.box.y };
        }}
        onResizeStart={() => {
          setInteracting(true);
          setVisibleGuides([]);
        }}
        onResize={({ target: resizeTarget, width, height, drag }: any) => {
          const clamped = clampBox({ x: drag.left, y: drag.top, width, height }, page, keepRatio ? elementRatio : undefined);
          const snapped = snapBox(clamped, snapReferences, page);
          resizeTarget.style.width = `${snapped.box.width}px`;
          resizeTarget.style.height = `${snapped.box.height}px`;
          resizeTarget.style.left = `${snapped.box.x}px`;
          resizeTarget.style.top = `${snapped.box.y}px`;
          setVisibleGuides(snapped.guides);
          pendingPatchRef.current = {
            width: snapped.box.width,
            height: snapped.box.height,
            x: snapped.box.x,
            y: snapped.box.y,
          };
        }}
        onRotateStart={() => {
          setInteracting(true);
          setVisibleGuides([]);
        }}
        onRotate={({ target: rotateTarget, rotate }: any) => {
          rotateTarget.style.transform = `rotate(${rotate}deg)`;
          pendingPatchRef.current = { rotation: Math.round(rotate) };
        }}
        onDragEnd={() => {
          setInteracting(false);
          setVisibleGuides([]);
          if (pendingPatchRef.current) {
            updateElement(selectedElement.id, pendingPatchRef.current);
            pendingPatchRef.current = null;
          }
        }}
        onResizeEnd={() => {
          setInteracting(false);
          setVisibleGuides([]);
          if (pendingPatchRef.current) {
            updateElement(selectedElement.id, pendingPatchRef.current);
            pendingPatchRef.current = null;
          }
        }}
        onRotateEnd={() => {
          setInteracting(false);
          setVisibleGuides([]);
          if (pendingPatchRef.current) {
            updateElement(selectedElement.id, pendingPatchRef.current);
            pendingPatchRef.current = null;
          }
        }}
      />
    </>
  );
}

function AlignmentGuideOverlay({ page, zoom, guides }: { page: NotePage; zoom: number; guides: AlignmentGuide[] }) {
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
) {
  let width = Math.max(1, Math.round(box.width));
  let height = Math.max(1, Math.round(box.height));
  if (aspectRatio && aspectRatio > 0) {
    height = Math.max(1, Math.round(width / aspectRatio));
    if (height > page.height) {
      height = page.height;
      width = Math.max(1, Math.round(height * aspectRatio));
    }
  }
  width = Math.min(width, page.width);
  height = Math.min(height, page.height);
  const x = Math.min(Math.max(0, Math.round(box.x)), Math.max(0, page.width - width));
  const y = Math.min(Math.max(0, Math.round(box.y)), Math.max(0, page.height - height));
  return { x, y, width, height };
}

import { useEffect, useRef, useState } from 'react';
import Moveable from 'react-moveable';
import { useDocument } from '../providers/DocumentProvider';
import type { NoteElement, NotePage } from '../types';

export function SelectionController({
  page,
  paperRef,
}: {
  page: NotePage;
  paperRef: React.RefObject<HTMLDivElement>;
}) {
  const { selectedElement, selectedElementId, editingElementId, updateElement, zoom } = useDocument();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [blockedByModal, setBlockedByModal] = useState(false);
  const pendingPatchRef = useRef<Partial<NoteElement> | null>(null);
  const editing = Boolean(selectedElementId && selectedElementId === editingElementId);

  useEffect(() => {
    if (!selectedElementId) {
      setTarget(null);
      return;
    }
    setTarget(document.querySelector<HTMLElement>(`[data-element-id="${selectedElementId}"]`));
  }, [selectedElementId, selectedElement]);

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
    <Moveable
      target={target}
      container={paperRef.current?.parentElement ?? undefined}
      zoom={zoom}
      origin={false}
      draggable={!editing}
      resizable={!editing}
      rotatable={!editing}
      snappable
      keepRatio={false}
      bounds={{ left: 0, top: 0, right: page.width, bottom: page.height }}
      horizontalGuidelines={[0, page.height / 2, page.height]}
      verticalGuidelines={[0, page.width / 2, page.width]}
      onDrag={({ target: dragTarget, left, top }: any) => {
        dragTarget.style.left = `${left}px`;
        dragTarget.style.top = `${top}px`;
        pendingPatchRef.current = { x: Math.round(left), y: Math.round(top) };
      }}
      onResize={({ target: resizeTarget, width, height, drag }: any) => {
        resizeTarget.style.width = `${width}px`;
        resizeTarget.style.height = `${height}px`;
        resizeTarget.style.left = `${drag.left}px`;
        resizeTarget.style.top = `${drag.top}px`;
        pendingPatchRef.current = {
          width: Math.round(width),
          height: Math.round(height),
          x: Math.round(drag.left),
          y: Math.round(drag.top),
        };
      }}
      onRotate={({ target: rotateTarget, rotate }: any) => {
        rotateTarget.style.transform = `rotate(${rotate}deg)`;
        pendingPatchRef.current = { rotation: Math.round(rotate) };
      }}
      onDragEnd={() => {
        if (pendingPatchRef.current) {
          updateElement(selectedElement.id, pendingPatchRef.current);
          pendingPatchRef.current = null;
        }
      }}
      onResizeEnd={() => {
        if (pendingPatchRef.current) {
          updateElement(selectedElement.id, pendingPatchRef.current);
          pendingPatchRef.current = null;
        }
      }}
      onRotateEnd={() => {
        if (pendingPatchRef.current) {
          updateElement(selectedElement.id, pendingPatchRef.current);
          pendingPatchRef.current = null;
        }
      }}
    />
  );
}

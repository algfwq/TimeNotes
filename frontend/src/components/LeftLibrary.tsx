import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Avatar, Button, Input, Modal, Tabs, Tooltip, Typography } from '@douyinfe/semi-ui';
import { IconDelete, IconEdit, IconFile, IconHandle, IconPlus } from '@douyinfe/semi-icons';
import { isMobile } from '../lib/platform';
import { useDocument } from '../providers/DocumentProvider';
import { useCollaboration } from '../providers/CollaborationProvider';
import type { PresenceUser } from '../types';
import { AssetLibrary } from './library/AssetLibrary';
import { CollaborationPanel } from './library/CollaborationPanel';

/** 触控长按打开页面菜单的阈值；移动过阈值则转为拖拽排序。 */
const PAGE_LONG_PRESS_MS = 480;
const PAGE_DRAG_MOVE_PX = 10;

export function LeftLibrary() {
  const mobileHost = isMobile();
  const [pagesHeight, setPagesHeight] = useState(mobileHost ? 300 : 260);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PagesPanel height={pagesHeight} />
      <SectionResizeHandle onResize={setPagesHeight} touchFriendly={mobileHost} />
      <Tabs
        className="timenotes-left-tabs flex min-h-0 flex-1 flex-col"
        defaultActiveKey="assets"
        tabPaneMotion={false}
        tabBarStyle={{ padding: '0 14px', margin: 0 }}
      >
        <Tabs.TabPane tab="素材" itemKey="assets" className="min-h-0 flex-1 overflow-hidden">
          <AssetLibrary />
        </Tabs.TabPane>
        <Tabs.TabPane tab="协作" itemKey="collab" className="min-h-0 flex-1 overflow-hidden">
          <CollaborationPanel />
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}

function PagesPanel({ height }: { height: number }) {
  const { document, activePageId, setActivePage, addPage, deletePage, renamePage, reorderPage } = useDocument();
  const { peers, canManagePages, isConnected } = useCollaboration();
  const mobileHost = isMobile();
  const [menu, setMenu] = useState<{ x: number; y: number; pageId: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ pageId: string; title: string } | null>(null);
  const [dragPageId, setDragPageId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const pageManagementLocked = isConnected && !canManagePages;

  const dragPageIdRef = useRef<string | null>(null);
  const dropTargetIdRef = useRef<string | null>(null);
  const pointerDragActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pageId: string; pointerId: number } | null>(null);

  const elementCountByPage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const element of document.elements) {
      counts.set(element.pageId, (counts.get(element.pageId) ?? 0) + 1);
    }
    return counts;
  }, [document.elements]);

  const collaboratorsByPage = useMemo(() => {
    const groups = new Map<string, PresenceUser[]>();
    for (const peer of peers) {
      if (!peer.pageId) {
        continue;
      }
      const current = groups.get(peer.pageId);
      if (current) {
        current.push(peer);
      } else {
        groups.set(peer.pageId, [peer]);
      }
    }
    return groups;
  }, [peers]);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const finishDrag = () => {
    clearLongPressTimer();
    pointerStartRef.current = null;
    dragPageIdRef.current = null;
    dropTargetIdRef.current = null;
    pointerDragActiveRef.current = false;
    setDragPageId(null);
    setDropTargetId(null);
  };

  /** 仅清理触控 pointer 拖拽；切勿在 HTML5 原生拖拽过程中调用，否则 pointercancel 会清掉 dragPageId。 */
  const finishTouchPointerDrag = () => {
    if (!pointerDragActiveRef.current && !pointerStartRef.current) {
      clearLongPressTimer();
      return;
    }
    clearLongPressTimer();
    pointerStartRef.current = null;
    if (pointerDragActiveRef.current) {
      dragPageIdRef.current = null;
      dropTargetIdRef.current = null;
      pointerDragActiveRef.current = false;
      setDragPageId(null);
      setDropTargetId(null);
    }
  };

  const beginTouchPageInteraction = (pageId: string, event: React.PointerEvent<HTMLDivElement>) => {
    // 桌面鼠标完全交给 HTML5 Drag and Drop，避免 pointercancel 打断原生拖拽。
    if (event.pointerType === 'mouse' || !mobileHost) {
      return;
    }
    if ((event.target as HTMLElement).closest('[data-page-action]')) {
      return;
    }

    const fromHandle = Boolean((event.target as HTMLElement).closest('[data-page-drag-handle]'));
    clearLongPressTimer();
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      pageId,
      pointerId: event.pointerId,
    };
    suppressClickRef.current = false;
    pointerDragActiveRef.current = false;
    dragPageIdRef.current = null;
    dropTargetIdRef.current = null;

    // 从手柄按下：直接进入排序拖拽，避免与列表滚动抢手势。
    if (fromHandle && canManagePages && document.pages.length > 1) {
      event.preventDefault();
      pointerDragActiveRef.current = true;
      suppressClickRef.current = true;
      dragPageIdRef.current = pageId;
      setDragPageId(pageId);
      setDropTargetId(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      try {
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(8);
        }
      } catch {
        // ignore
      }
      return;
    }

    // 行内长按：打开重命名/删除菜单（移动则取消，保留列表滚动）。
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      if (pointerDragActiveRef.current || !pointerStartRef.current || pointerStartRef.current.pageId !== pageId) {
        return;
      }
      const start = pointerStartRef.current;
      suppressClickRef.current = true;
      setMenu({ x: start.x, y: start.y, pageId });
      pointerStartRef.current = null;
      try {
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(12);
        }
      } catch {
        // ignore
      }
    }, PAGE_LONG_PRESS_MS);
  };

  const moveTouchPageInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || !mobileHost) {
      return;
    }
    const start = pointerStartRef.current;
    if (!start || start.pointerId !== event.pointerId) {
      return;
    }

    if (!pointerDragActiveRef.current) {
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) >= PAGE_DRAG_MOVE_PX;
      if (moved) {
        // 非手柄区域滑动：视为滚动列表，取消长按菜单。
        clearLongPressTimer();
        pointerStartRef.current = null;
      }
      return;
    }

    event.preventDefault();
    const el = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const row = el?.closest('[data-page-id]') as HTMLElement | null;
    const targetId = row?.getAttribute('data-page-id') || null;
    if (targetId && targetId !== dragPageIdRef.current) {
      dropTargetIdRef.current = targetId;
      setDropTargetId(targetId);
    }
  };

  const endTouchPageInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || !mobileHost) {
      return;
    }
    if (pointerStartRef.current && pointerStartRef.current.pointerId !== event.pointerId) {
      return;
    }
    clearLongPressTimer();
    if (pointerDragActiveRef.current) {
      const sourceId = dragPageIdRef.current;
      const targetId = dropTargetIdRef.current;
      if (sourceId && targetId && sourceId !== targetId) {
        reorderPage(sourceId, targetId);
      }
      finishDrag();
      return;
    }
    pointerStartRef.current = null;
  };

  useEffect(() => {
    const close = () => setMenu(null);
    const onCancel = () => {
      // 仅取消触控手势；桌面 HTML5 拖拽不依赖这些 ref。
      clearLongPressTimer();
      if (pointerDragActiveRef.current) {
        finishTouchPointerDrag();
      } else {
        pointerStartRef.current = null;
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', onCancel);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', onCancel);
      clearLongPressTimer();
    };
  }, []);

  return (
    <section className="flex min-h-0 shrink-0 flex-col border-b border-black/10 px-4 py-4" style={{ height }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Typography.Text strong>页面</Typography.Text>
        <Button size="small" type="primary" theme="solid" icon={<IconPlus />} onClick={addPage} disabled={pageManagementLocked}>
          新建
        </Button>
      </div>
      {mobileHost && canManagePages && document.pages.length > 1 ? (
        <div className="mb-2 text-xs text-black/40">拖左侧手柄可编排页面顺序；长按页面可重命名/删除</div>
      ) : null}
      <div className="timenotes-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto overscroll-contain pr-1">
        {document.pages.map((page, index) => {
          const active = page.id === activePageId;
          const count = elementCountByPage.get(page.id) ?? 0;
          const pageCollaborators = collaboratorsByPage.get(page.id) ?? [];
          const isDragging = dragPageId === page.id;
          const isDropTarget = dropTargetId === page.id && dragPageId !== page.id;
          return (
            <div
              key={page.id}
              data-page-id={page.id}
              data-page-title={page.title}
              data-page-collaborators={pageCollaborators.map((peer) => peer.id).join(',')}
              role="button"
              tabIndex={0}
              draggable={canManagePages && !mobileHost}
              className={`group flex items-center gap-2 rounded-[8px] border px-2 py-2 text-left transition select-none ${
                canManagePages ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
              } ${
                active ? 'border-[#2f6fed] bg-white shadow-sm' : 'border-transparent bg-white/45 hover:bg-white/75'
              } ${isDragging ? 'opacity-45 touch-none' : ''} ${
                isDropTarget ? 'ring-2 ring-[#2f6fed]/30 border-[#2f6fed]/40' : ''
              } ${mobileHost && !isDragging ? 'touch-manipulation' : ''}`}
              onPointerDown={mobileHost ? (event) => beginTouchPageInteraction(page.id, event) : undefined}
              onPointerMove={mobileHost ? moveTouchPageInteraction : undefined}
              onPointerUp={mobileHost ? endTouchPageInteraction : undefined}
              onPointerCancel={mobileHost ? finishTouchPointerDrag : undefined}
              onDragStart={(event) => {
                if (!canManagePages || mobileHost) {
                  event.preventDefault();
                  return;
                }
                if ((event.target as HTMLElement).closest('[data-page-action]')) {
                  event.preventDefault();
                  return;
                }
                setDragPageId(page.id);
                dragPageIdRef.current = page.id;
                dropTargetIdRef.current = null;
                setDropTargetId(null);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/timenotes-page-id', page.id);
                // 部分 WebView/浏览器只稳定暴露 text/plain，drop 时作兜底。
                event.dataTransfer.setData('text/plain', page.id);
              }}
              onDragOver={(event) => {
                // 用 ref 判断来源：HTML5 拖拽开始时 pointercancel 曾误清 state，ref 更稳；且 state 异步。
                const sourceId = dragPageIdRef.current;
                if (canManagePages && sourceId && sourceId !== page.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dropTargetIdRef.current !== page.id) {
                    dropTargetIdRef.current = page.id;
                    setDropTargetId(page.id);
                  }
                }
              }}
              onDragLeave={() => {
                if (dropTargetIdRef.current === page.id) {
                  dropTargetIdRef.current = null;
                  setDropTargetId(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!canManagePages) {
                  finishDrag();
                  return;
                }
                const sourceId =
                  event.dataTransfer.getData('text/timenotes-page-id') ||
                  event.dataTransfer.getData('text/plain') ||
                  dragPageIdRef.current ||
                  dragPageId;
                if (sourceId && sourceId !== page.id) {
                  reorderPage(sourceId, page.id);
                }
                finishDrag();
              }}
              onDragEnd={finishDrag}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                setActivePage(page.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // 页面操作放在右键/长按菜单里，避免常用的页面切换区域被额外按钮挤占。
                setMenu({ x: event.clientX, y: event.clientY, pageId: page.id });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setActivePage(page.id);
                }
              }}
            >
              {canManagePages && document.pages.length > 1 ? (
                <span
                  data-page-drag-handle
                  className={`shrink-0 text-black/35 ${mobileHost ? 'touch-none p-2 -ml-1' : 'p-0.5'}`}
                  title="拖动排序"
                  aria-label="拖动排序"
                  role="button"
                >
                  <IconHandle size={mobileHost ? 'large' : 'default'} />
                </span>
              ) : null}
              <div className="grid h-12 w-9 shrink-0 place-items-center rounded-[4px] border border-black/10 bg-[#fffaf0] shadow-sm">
                <IconFile className={active ? 'text-[#2f6fed]' : 'text-black/35'} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{page.title || `第 ${index + 1} 页`}</div>
                <div className="text-xs text-black/45">
                  {count} 个元素
                  {mobileHost && canManagePages && document.pages.length > 1 ? ' · 可拖动' : ''}
                </div>
              </div>
              <CollaboratorPageBadges peers={pageCollaborators} />
              {canManagePages && document.pages.length > 1 ? (
                <Button
                  size="small"
                  type="danger"
                  theme="borderless"
                  icon={<IconDelete />}
                  data-page-action="delete"
                  aria-label={`删除 ${page.title || `第 ${index + 1} 页`}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    deletePage(page.id);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <PageContextMenu
        state={menu}
        canDelete={canManagePages && document.pages.length > 1}
        canManagePages={canManagePages}
        onRename={(pageId) => {
          if (!canManagePages) {
            return;
          }
          const page = document.pages.find((item) => item.id === pageId);
          if (page) {
            setRenameTarget({ pageId, title: page.title });
          }
          setMenu(null);
        }}
        onDelete={(pageId) => {
          if (!canManagePages) {
            return;
          }
          deletePage(pageId);
          setMenu(null);
        }}
      />
      <Modal
        title="重命名页面"
        visible={Boolean(renameTarget)}
        okText="确认"
        cancelText="取消"
        onCancel={() => setRenameTarget(null)}
        onOk={() => {
          if (renameTarget && canManagePages) {
            renamePage(renameTarget.pageId, renameTarget.title);
          }
          setRenameTarget(null);
        }}
      >
        <Input value={renameTarget?.title ?? ''} onChange={(title) => setRenameTarget((current) => (current ? { ...current, title } : current))} />
      </Modal>
      {pageManagementLocked ? <div className="mt-2 text-xs text-black/45">当前为协作者身份，页面排序、重命名和删除仅房主可操作。</div> : null}
    </section>
  );
}

function CollaboratorPageBadges({ peers }: { peers: PresenceUser[] }) {
  if (peers.length === 0) {
    return null;
  }

  const visiblePeers = peers.slice(0, 3);
  const overflowCount = peers.length - visiblePeers.length;
  const tooltip = peers
    .map((peer) => {
      const action = peer.editingElementId ? '正在编辑元素' : peer.selectedElementId ? '正在查看元素' : '正在此页面';
      return `${peer.name || '匿名协作者'}：${action}`;
    })
    .join('\n');

  return (
    <Tooltip content={<span className="whitespace-pre-line">{tooltip}</span>}>
      <div
        className="flex shrink-0 items-center -space-x-1 rounded-full border border-[#2f6fed]/20 bg-white/90 px-1 py-0.5 shadow-sm"
        aria-label={`${peers.length} 位协作者正在此页面`}
      >
        {visiblePeers.map((peer) => (
          <Avatar
            key={peer.id}
            size="small"
            style={{
              width: 20,
              height: 20,
              border: '1px solid #fff',
              background: peer.color || '#2f6fed',
              fontSize: 10,
              lineHeight: '20px',
            }}
          >
            {avatarLabel(peer.name)}
          </Avatar>
        ))}
        {overflowCount > 0 ? <span className="grid h-5 min-w-5 place-items-center rounded-full border border-white bg-black/70 px-1 text-[10px] font-medium text-white">+{overflowCount}</span> : null}
      </div>
    </Tooltip>
  );
}

function avatarLabel(name: string) {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '协';
}

function SectionResizeHandle({
  onResize,
  touchFriendly,
}: {
  onResize: Dispatch<SetStateAction<number>>;
  touchFriendly?: boolean;
}) {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    const startY = event.clientY;
    onResize((startHeight) => {
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        const delta = moveEvent.clientY - startY;
        onResize(Math.min(520, Math.max(150, startHeight + delta)));
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
      return startHeight;
    });
  };

  const hit = touchFriendly ? 'h-3' : 'h-1.5';
  return (
    <div
      title="拖拽调整页面和素材区域大小"
      className={`${hit} shrink-0 cursor-row-resize touch-none bg-transparent hover:bg-[#2f6fed]/20 active:bg-[#2f6fed]/30`}
      onPointerDown={startDrag}
    />
  );
}

function PageContextMenu({
  state,
  canDelete,
  canManagePages,
  onRename,
  onDelete,
}: {
  state: { x: number; y: number; pageId: string } | null;
  canDelete: boolean;
  canManagePages: boolean;
  onRename: (pageId: string) => void;
  onDelete: (pageId: string) => void;
}) {
  if (!state) {
    return null;
  }
  return (
    <div
      className="fixed z-[900] min-w-36 rounded-[8px] border border-black/10 bg-white py-1 text-sm shadow-xl"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {canManagePages ? (
        <>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5" onClick={() => onRename(state.pageId)}>
            <IconEdit />
            <span>重命名页面</span>
          </button>
          {canDelete ? (
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-black/5" onClick={() => onDelete(state.pageId)}>
              <IconDelete />
              <span>删除页面</span>
            </button>
          ) : null}
        </>
      ) : (
        <div className="px-3 py-2 text-xs text-black/50">只有房主可以管理页面</div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Avatar, Button, Input, Modal, Tabs, Tooltip, Typography } from '@douyinfe/semi-ui';
import { IconDelete, IconEdit, IconFile, IconPlus } from '@douyinfe/semi-icons';
import { useDocument } from '../providers/DocumentProvider';
import { useCollaboration } from '../providers/CollaborationProvider';
import type { PresenceUser } from '../types';
import { AssetLibrary } from './library/AssetLibrary';
import { CollaborationPanel } from './library/CollaborationPanel';

export function LeftLibrary() {
  const [pagesHeight, setPagesHeight] = useState(260);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PagesPanel height={pagesHeight} />
      <SectionResizeHandle onResize={setPagesHeight} />
      <Tabs
        className="timenotes-left-tabs flex min-h-0 flex-1 flex-col"
        defaultActiveKey="assets"
        tabPaneMotion={false}
        tabBarStyle={{ padding: '0 14px', margin: 0 }}
      >
        <Tabs.TabPane tab="素材" itemKey="assets" className="min-h-0 flex-1 overflow-hidden">
          <AssetLibrary />
        </Tabs.TabPane>
        <Tabs.TabPane tab="协同" itemKey="collab" className="min-h-0 flex-1 overflow-hidden">
          <CollaborationPanel />
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}

function PagesPanel({ height }: { height: number }) {
  const { document, activePageId, setActivePage, addPage, deletePage, renamePage, reorderPage } = useDocument();
  const { peers, canManagePages, isConnected } = useCollaboration();
  const [menu, setMenu] = useState<{ x: number; y: number; pageId: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ pageId: string; title: string } | null>(null);
  const [dragPageId, setDragPageId] = useState<string | null>(null);
  const pageManagementLocked = isConnected && !canManagePages;

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

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  return (
    <section className="flex min-h-0 shrink-0 flex-col border-b border-black/10 px-4 py-4" style={{ height }}>
      <div className="mb-3 flex items-center justify-between">
        <Typography.Text strong>页面</Typography.Text>
        <Button size="small" type="primary" theme="solid" icon={<IconPlus />} onClick={addPage}>
          新建
        </Button>
      </div>
      <div className="timenotes-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
        {document.pages.map((page, index) => {
          const active = page.id === activePageId;
          const count = elementCountByPage.get(page.id) ?? 0;
          const pageCollaborators = collaboratorsByPage.get(page.id) ?? [];
          return (
            <div
              key={page.id}
              data-page-id={page.id}
              data-page-title={page.title}
              data-page-collaborators={pageCollaborators.map((peer) => peer.id).join(',')}
              role="button"
              tabIndex={0}
              draggable={canManagePages}
              className={`group flex items-center gap-3 rounded-[8px] border px-2 py-2 text-left transition ${
                canManagePages ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
              } ${
                active ? 'border-[#2f6fed] bg-white shadow-sm' : 'border-transparent bg-white/45 hover:bg-white/75'
              } ${dragPageId === page.id ? 'opacity-45' : ''}`}
              onDragStart={(event) => {
                if (!canManagePages) {
                  event.preventDefault();
                  return;
                }
                setDragPageId(page.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/timenotes-page-id', page.id);
              }}
              onDragOver={(event) => {
                if (canManagePages && dragPageId && dragPageId !== page.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!canManagePages) {
                  setDragPageId(null);
                  return;
                }
                const sourceId = event.dataTransfer.getData('text/timenotes-page-id') || dragPageId;
                if (sourceId && sourceId !== page.id) {
                  reorderPage(sourceId, page.id);
                }
                setDragPageId(null);
              }}
              onDragEnd={() => setDragPageId(null)}
              onClick={() => setActivePage(page.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // 页面操作放在右键菜单里，避免常用的页面切换区域被额外按钮挤占。
                setMenu({ x: event.clientX, y: event.clientY, pageId: page.id });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setActivePage(page.id);
                }
              }}
            >
              <div className="grid h-12 w-9 shrink-0 place-items-center rounded-[4px] border border-black/10 bg-[#fffaf0] shadow-sm">
                <IconFile className={active ? 'text-[#2f6fed]' : 'text-black/35'} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{page.title || `第 ${index + 1} 页`}</div>
                <div className="text-xs text-black/45">{count} 个元素</div>
              </div>
              <CollaboratorPageBadges peers={pageCollaborators} />
              {canManagePages && document.pages.length > 1 ? (
                <Button
                  size="small"
                  type="danger"
                  theme="borderless"
                  icon={<IconDelete />}
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

function SectionResizeHandle({ onResize }: { onResize: Dispatch<SetStateAction<number>> }) {
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    onResize((startHeight) => {
      const move = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        onResize(Math.min(520, Math.max(150, startHeight + delta)));
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      return startHeight;
    });
  };

  return <div title="拖拽调整页面和素材区域大小" className="h-1.5 shrink-0 cursor-row-resize bg-transparent hover:bg-[#2f6fed]/20" onPointerDown={startDrag} />;
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

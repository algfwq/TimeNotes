import { useEffect, useState } from 'react';
import { Button, Input, Modal, Tabs, Typography } from '@douyinfe/semi-ui';
import { IconDelete, IconEdit, IconFile, IconPlus } from '@douyinfe/semi-icons';
import { useDocument } from '../providers/DocumentProvider';
import { AssetLibrary } from './library/AssetLibrary';
import { CollaborationPanel } from './library/CollaborationPanel';

export function LeftLibrary() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PagesPanel />
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

function PagesPanel() {
  const { document, activePageId, setActivePage, addPage, deletePage, renamePage } = useDocument();
  const [menu, setMenu] = useState<{ x: number; y: number; pageId: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ pageId: string; title: string } | null>(null);

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
    <section className="shrink-0 border-b border-black/10 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <Typography.Text strong>页面</Typography.Text>
        <Button size="small" type="primary" theme="solid" icon={<IconPlus />} onClick={addPage}>
          新建
        </Button>
      </div>
      <div className="flex max-h-48 flex-col gap-2 overflow-auto pr-1">
        {document.pages.map((page, index) => {
          const active = page.id === activePageId;
          const count = document.elements.filter((element) => element.pageId === page.id).length;
          return (
            <div
              key={page.id}
              data-page-id={page.id}
              data-page-title={page.title}
              role="button"
              tabIndex={0}
              className={`group flex items-center gap-3 rounded-[8px] border px-2 py-2 text-left transition ${
                active ? 'border-[#2f6fed] bg-white shadow-sm' : 'border-transparent bg-white/45 hover:bg-white/75'
              }`}
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
              {document.pages.length > 1 ? (
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
        canDelete={document.pages.length > 1}
        onRename={(pageId) => {
          const page = document.pages.find((item) => item.id === pageId);
          if (page) {
            setRenameTarget({ pageId, title: page.title });
          }
          setMenu(null);
        }}
        onDelete={(pageId) => {
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
          if (renameTarget) {
            renamePage(renameTarget.pageId, renameTarget.title);
          }
          setRenameTarget(null);
        }}
      >
        <Input value={renameTarget?.title ?? ''} onChange={(title) => setRenameTarget((current) => (current ? { ...current, title } : current))} />
      </Modal>
    </section>
  );
}

function PageContextMenu({
  state,
  canDelete,
  onRename,
  onDelete,
}: {
  state: { x: number; y: number; pageId: string } | null;
  canDelete: boolean;
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
    </div>
  );
}

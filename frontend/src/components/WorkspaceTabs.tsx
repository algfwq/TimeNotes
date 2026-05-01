import { useEffect, useState } from 'react';
import { Button, Input, Modal, Tooltip } from '@douyinfe/semi-ui';
import { IconBookOpenStroked, IconClose, IconEdit, IconFile } from '@douyinfe/semi-icons';
import { useDocument } from '../providers/DocumentProvider';

export function WorkspaceTabs() {
  const { tabs, activeTabId, switchTab, closeTab, renameTab } = useDocument();
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ tabId: string; title: string } | null>(null);

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
    <>
      <div
        data-workspace-tabs
        className="flex h-9 w-full min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-t border-black/5 bg-[#f7f4ed] px-3"
        style={{ scrollbarGutter: 'stable' }}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              data-tab-mode={tab.mode}
              data-active={active ? 'true' : 'false'}
              role="button"
              tabIndex={0}
              className={`flex h-7 max-w-56 shrink-0 items-center gap-2 rounded-[6px] border px-2 text-sm transition ${
                active ? 'border-[#2f6fed] bg-white text-[#1f5fd2] shadow-sm' : 'border-transparent bg-white/45 text-black/60 hover:bg-white'
              }`}
              onClick={() => switchTab(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  switchTab(tab.id);
                }
              }}
            >
              {tab.mode === 'reader' ? <IconBookOpenStroked /> : <IconFile />}
              <span className="truncate">{tab.title}</span>
              {tabs.length > 1 ? (
                <Tooltip content="关闭标签">
                  <Button
                    size="small"
                    theme="borderless"
                    icon={<IconClose />}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  />
                </Tooltip>
              ) : null}
            </div>
          );
        })}
      </div>
      <TabContextMenu
        state={menu}
        onRename={(tabId) => {
          const tab = tabs.find((item) => item.id === tabId);
          if (tab) {
            setRenameTarget({ tabId, title: tab.title });
          }
          setMenu(null);
        }}
      />
      <Modal
        title="重命名标签页"
        visible={Boolean(renameTarget)}
        okText="确认"
        cancelText="取消"
        onCancel={() => setRenameTarget(null)}
        onOk={() => {
          if (renameTarget) {
            renameTab(renameTarget.tabId, renameTarget.title);
          }
          setRenameTarget(null);
        }}
      >
        <Input value={renameTarget?.title ?? ''} onChange={(title) => setRenameTarget((current) => (current ? { ...current, title } : current))} />
      </Modal>
    </>
  );
}

function TabContextMenu({ state, onRename }: { state: { x: number; y: number; tabId: string } | null; onRename: (tabId: string) => void }) {
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
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5" onClick={() => onRename(state.tabId)}>
        <IconEdit />
        <span>重命名标签</span>
      </button>
    </div>
  );
}

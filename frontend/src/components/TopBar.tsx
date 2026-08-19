import { useMemo, useState } from 'react';
import { Button, ButtonGroup, Input, Modal, Space, Toast, Tooltip, Typography } from '@douyinfe/semi-ui';
import { Dialogs } from '@wailsio/runtime';
import {
  IconBookOpenStroked,
  IconCodeStroked,
  IconEdit2,
  IconFile,
  IconFolderOpen,
  IconHandle,
  IconHome,
  IconPlus,
  IconRedo,
  IconSave,
  IconText,
  IconUndo,
} from '@douyinfe/semi-icons';
import logoUrl from '../assets/timenotes-logo.png';
import { logFrontend } from '../lib/logger';
import { isMobile } from '../lib/platform';
import { useDocument } from '../providers/DocumentProvider';
import type { ToolMode } from '../types';

const toolItems: Array<{ key: ToolMode; label: string; icon: React.ReactNode }> = [
  { key: 'select', label: '选择', icon: <IconHandle /> },
  { key: 'pan', label: '移动画布', icon: <IconHandle /> },
  { key: 'text', label: '文本', icon: <IconText /> },
  { key: 'code', label: '代码块', icon: <IconCodeStroked /> },
  { key: 'sticker', label: '贴纸', icon: <IconPlus /> },
  { key: 'tape', label: '胶带笔', icon: <IconFile /> },
  { key: 'drawing', label: '画笔', icon: <IconEdit2 /> },
];

const noteFilter = [{ DisplayName: 'TimeNotes 文件', Pattern: '*.tnote' }];

export function TopBar({ compactChrome = false }: { compactChrome?: boolean }) {
  const { document, activeTabMode, activeTabId, tabs, createPackage, openNotebookPath, saveActiveTab, openHomeTab, openReadTab, tool, setTool, undo, redo, canUndo, canRedo } = useDocument();
  const [savePath, setSavePath] = useState('sample.tnote');
  const [openPath, setOpenPath] = useState('');
  const [saveDirectoryTrusted, setSaveDirectoryTrusted] = useState(false);
  const [saveVisible, setSaveVisible] = useState(false);
  const [openVisible, setOpenVisible] = useState(false);
  // 仅窄屏 compactChrome：压缩顶栏；宽屏平板与桌面一致（完整文字按钮）

  const updatedAt = useMemo(() => new Date(document.updatedAt).toLocaleString(), [document.updatedAt]);

  const handleSaveOrSaveAs = async () => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab?.sourcePath && activeTab.mode === 'edit') {
      try {
        await saveActiveTab();
        Toast.success('已保存');
      } catch (error) {
        Toast.error(`保存失败：${String(error)}`);
      }
      return;
    }
    if (isMobile()) {
      Toast.warning('移动端请从首页「新建手账」创建后再保存');
      openHomeTab();
      return;
    }
    setSaveVisible(true);
  };

  const openNote = async () => {
    try {
      await openNotebookPath(openPath);
      setSavePath(openPath);
      setSaveDirectoryTrusted(true);
      Toast.success('已打开手账本');
      logFrontend('info', 'note_opened', { path: openPath });
      setOpenVisible(false);
    } catch (error) {
      logFrontend('error', 'note_open_failed', { path: openPath, error: String(error) });
      Toast.error(`打开失败：${String(error)}`);
    }
  };

  const chooseOpenPath = async () => {
    try {
      const selected = await Dialogs.OpenFile({
        Title: '打开 TimeNotes 文件',
        CanChooseFiles: true,
        AllowsMultipleSelection: false,
        Filters: noteFilter,
      });
      if (typeof selected === 'string' && selected) {
        setOpenPath(selected);
      }
    } catch (error) {
      Toast.warning('当前预览环境不可用系统文件对话框，请手动填写路径');
      logFrontend('warn', 'open_dialog_unavailable', { error: String(error) });
    }
  };

  const chooseSavePath = async () => {
    if (isMobile()) {
      Toast.warning('移动端不支持另存为到任意路径，请使用首页手账库');
      return;
    }
    try {
      const selected = await Dialogs.SaveFile({
        Title: '保存 TimeNotes 文件',
        Filename: fileNameFromPath(savePath) || 'sample.tnote',
        ...(saveDirectoryTrusted ? { Directory: directoryFromPath(savePath) } : {}),
        CanCreateDirectories: true,
        Filters: noteFilter,
      });
      if (selected) {
        setSavePath(selected.endsWith('.tnote') ? selected : `${selected}.tnote`);
        setSaveDirectoryTrusted(true);
      }
    } catch (error) {
      Toast.warning('当前预览环境不可用系统文件对话框，请手动填写路径');
      logFrontend('warn', 'save_dialog_unavailable', { error: String(error) });
    }
  };

  return (
    <div className={`timenotes-topbar flex min-h-14 items-center gap-3 px-4 py-2 ${compactChrome ? 'flex-nowrap' : 'flex-wrap'}`}>
      <div className={`flex shrink-0 items-center ${compactChrome ? 'gap-2' : 'gap-3'}`}>
        <img
          className={`rounded-[8px] object-cover shadow-sm ${compactChrome ? 'h-8 w-8' : 'h-10 w-10'}`}
          src={logoUrl}
          alt="TimeNotes"
          draggable={false}
        />
        {/* 窄屏压缩标题；宽屏/桌面保留完整标题与更新时间 */}
        {!compactChrome ? (
          <div>
            <Typography.Text strong>{document.title}</Typography.Text>
            <div className="text-xs text-black/45 dark:text-white/40">更新于 {updatedAt}</div>
          </div>
        ) : (
          <Typography.Text strong className="max-w-[7rem] truncate text-sm">
            {document.title}
          </Typography.Text>
        )}
      </div>

      <div className={`timenotes-topbar-tools flex min-w-0 flex-1 justify-center px-2 ${compactChrome ? 'overflow-x-auto' : ''}`}>
        <ButtonGroup className={compactChrome ? 'flex-nowrap' : undefined}>
          {toolItems.map((item) => (
            <Tooltip key={item.key} content={item.label}>
              <Button
                type={tool === item.key ? 'primary' : 'tertiary'}
                theme={tool === item.key ? 'solid' : 'light'}
                icon={item.icon}
                aria-label={item.label}
                title={item.label}
                size={compactChrome ? 'small' : 'default'}
                disabled={activeTabMode !== 'edit'}
                onClick={() => {
                  setTool(item.key);
                  window.dispatchEvent(new Event('timenotes-open-controls'));
                }}
              >
                {compactChrome ? null : item.label}
              </Button>
            </Tooltip>
          ))}
        </ButtonGroup>
      </div>

      <Space className="shrink-0" spacing={compactChrome ? 4 : 8}>
        <ButtonGroup>
          <Tooltip content="撤销">
            <Button size={compactChrome ? 'small' : 'default'} icon={<IconUndo />} disabled={!canUndo || activeTabMode !== 'edit'} onClick={undo} />
          </Tooltip>
          <Tooltip content="恢复">
            <Button size={compactChrome ? 'small' : 'default'} icon={<IconRedo />} disabled={!canRedo || activeTabMode !== 'edit'} onClick={redo} />
          </Tooltip>
        </ButtonGroup>
        <Tooltip content="首页">
          <Button size={compactChrome ? 'small' : 'default'} icon={<IconHome />} onClick={openHomeTab}>
            {compactChrome ? null : '首页'}
          </Button>
        </Tooltip>
        {/* 宽屏与桌面：保留「打开」；窄屏隐藏（仍可走首页手账库） */}
        {!compactChrome ? (
          <Button icon={<IconFolderOpen />} onClick={() => setOpenVisible(true)}>
            打开
          </Button>
        ) : null}
        <Tooltip content="阅读">
          <Button size={compactChrome ? 'small' : 'default'} icon={<IconBookOpenStroked />} onClick={openReadTab}>
            {compactChrome ? null : '阅读'}
          </Button>
        </Tooltip>
        <Tooltip content="保存">
          <Button
            size={compactChrome ? 'small' : 'default'}
            type="primary"
            theme="solid"
            icon={<IconSave />}
            disabled={activeTabMode !== 'edit'}
            onClick={handleSaveOrSaveAs}
          >
            {compactChrome ? null : '保存'}
          </Button>
        </Tooltip>
      </Space>

      <PathModal
        title="保存 .tnote"
        visible={saveVisible}
        value={savePath}
        actionText="保存"
        onChoosePath={chooseSavePath}
        onChange={(value) => {
          setSavePath(value);
          setSaveDirectoryTrusted(false);
        }}
        onCancel={() => setSaveVisible(false)}
        onOk={async () => {
          try {
            const { saveNotePackage } = await import('../lib/mobileSave');
            await saveNotePackage(savePath, createPackage());
            Toast.success('已保存');
            setSaveVisible(false);
          } catch (error) {
            Toast.error(`保存失败：${String(error)}`);
          }
        }}
      />
      <PathModal
        title="打开 .tnote"
        visible={openVisible}
        value={openPath}
        actionText="打开"
        onChoosePath={chooseOpenPath}
        onChange={setOpenPath}
        onCancel={() => setOpenVisible(false)}
        onOk={openNote}
      />
    </div>
  );
}

function PathModal({
  title,
  visible,
  value,
  actionText,
  onChoosePath,
  onChange,
  onCancel,
  onOk,
}: {
  title: string;
  visible: boolean;
  value: string;
  actionText: string;
  onChoosePath: () => void | Promise<void>;
  onChange: (value: string) => void;
  onCancel: () => void;
  onOk: () => void | Promise<void>;
}) {
  return (
    <Modal title={title} visible={visible} onCancel={onCancel} onOk={onOk} okText={actionText} cancelText="取消">
      <div className="flex gap-2">
        <Input value={value} onChange={onChange} placeholder="文件路径" />
        <Button onClick={() => void onChoosePath()}>浏览</Button>
      </div>
    </Modal>
  );
}

function fileNameFromPath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function directoryFromPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

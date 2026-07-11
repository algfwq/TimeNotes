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
import { DocumentService } from '../../bindings/changeme';
import logoUrl from '../assets/timenotes-logo.png';
import { logFrontend } from '../lib/logger';
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

export function TopBar() {
  const { document, activeTabMode, activeTabId, tabs, createPackage, openNotebookPath, saveActiveTab, openHomeTab, openReadTab, tool, setTool, undo, redo, canUndo, canRedo } = useDocument();
  const [savePath, setSavePath] = useState('sample.tnote');
  const [openPath, setOpenPath] = useState('');
  const [saveDirectoryTrusted, setSaveDirectoryTrusted] = useState(false);
  const [saveVisible, setSaveVisible] = useState(false);
  const [openVisible, setOpenVisible] = useState(false);

  const updatedAt = useMemo(() => new Date(document.updatedAt).toLocaleString(), [document.updatedAt]);

  const handleSaveOrSaveAs = async () => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab?.sourcePath && activeTab.mode === 'edit') {
      // 已有路径，直接保存（和自动保存逻辑一致）。
      try {
        await saveActiveTab();
        Toast.success('已保存');
      } catch (error) {
        Toast.error(`保存失败：${String(error)}`);
      }
    } else {
      setSaveVisible(true);
    }
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
    <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2">
      <div className="flex shrink-0 items-center gap-3">
        <img className="h-10 w-10 rounded-[8px] object-cover shadow-sm" src={logoUrl} alt="TimeNotes" draggable={false} />
        <div>
          <Typography.Text strong>{document.title}</Typography.Text>
          <div className="text-xs text-black/45">更新于 {updatedAt}</div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 justify-center overflow-x-auto px-2">
        <ButtonGroup>
          {toolItems.map((item) => (
            <Tooltip key={item.key} content={item.label}>
              <Button
                type={tool === item.key ? 'primary' : 'tertiary'}
                theme={tool === item.key ? 'solid' : 'light'}
                icon={item.icon}
                aria-label={item.label}
                title={item.label}
                disabled={activeTabMode !== 'edit'}
                onClick={() => {
                  setTool(item.key);
                  window.dispatchEvent(new Event('timenotes-open-controls'));
                }}
              >
                {item.label}
              </Button>
            </Tooltip>
          ))}
        </ButtonGroup>
      </div>

      <Space className="shrink-0">
        <ButtonGroup>
          <Tooltip content="撤销">
            <Button icon={<IconUndo />} disabled={!canUndo || activeTabMode !== 'edit'} onClick={undo} />
          </Tooltip>
          <Tooltip content="恢复">
            <Button icon={<IconRedo />} disabled={!canRedo || activeTabMode !== 'edit'} onClick={redo} />
          </Tooltip>
        </ButtonGroup>
        <Button icon={<IconHome />} onClick={openHomeTab}>
          首页
        </Button>
        <Button icon={<IconFolderOpen />} onClick={() => setOpenVisible(true)}>
          打开
        </Button>
        <Button icon={<IconBookOpenStroked />} onClick={openReadTab}>
          阅读
        </Button>
        <Button type="primary" theme="solid" icon={<IconSave />} disabled={activeTabMode !== 'edit'} onClick={handleSaveOrSaveAs}>
          保存
        </Button>
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
            await DocumentService.SaveNote(savePath, createPackage() as any);
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
  onChoosePath: () => void;
  onChange: (value: string) => void;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <Modal title={title} visible={visible} onCancel={onCancel} onOk={onOk} okText={actionText} cancelText="取消">
      <Input
        value={value}
        onChange={onChange}
        suffix={
          <Button size="small" theme="borderless" icon={<IconFolderOpen />} onClick={onChoosePath}>
            选择
          </Button>
        }
      />
    </Modal>
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() ?? '';
}

function directoryFromPath(path: string) {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index > 0 ? path.slice(0, index) : undefined;
}

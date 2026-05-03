import { useMemo, useState } from 'react';
import { Button, ButtonGroup, Input, Modal, Space, Toast, Tooltip, Typography } from '@douyinfe/semi-ui';
import { Dialogs } from '@wailsio/runtime';
import {
  IconBookOpenStroked,
  IconEdit2,
  IconFile,
  IconFolderOpen,
  IconHandle,
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
  { key: 'sticker', label: '贴纸', icon: <IconPlus /> },
  { key: 'tape', label: '胶带笔', icon: <IconFile /> },
  { key: 'drawing', label: '画笔', icon: <IconEdit2 /> },
];

const noteFilter = [{ DisplayName: 'TimeNotes 文件', Pattern: '*.tnote' }];

export function TopBar() {
  const { document, activeTabMode, createPackage, loadPackage, createNewDocument, openReadTab, tool, setTool, undo, redo, canUndo, canRedo } = useDocument();
  const [savePath, setSavePath] = useState('D:\\TimeNotes\\TimeNotes\\sample.tnote');
  const [openPath, setOpenPath] = useState('D:\\TimeNotes\\TimeNotes\\sample.tnote');
  const [saveVisible, setSaveVisible] = useState(false);
  const [openVisible, setOpenVisible] = useState(false);

  const updatedAt = useMemo(() => new Date(document.updatedAt).toLocaleString(), [document.updatedAt]);

  const saveNote = async () => {
    try {
      await DocumentService.SaveNote(savePath, createPackage() as any);
      Toast.success('已保存 .tnote 文件');
      logFrontend('info', 'note_saved', { path: savePath });
      setSaveVisible(false);
    } catch (error) {
      logFrontend('error', 'note_save_failed', { path: savePath, error: String(error) });
      Toast.error(`保存失败：${String(error)}`);
    }
  };

  const openNote = async () => {
    try {
      const note = await DocumentService.OpenNote(openPath);
      loadPackage(note as any, openPath);
      Toast.success('已打开 .tnote 文件');
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
        Directory: directoryFromPath(savePath),
        CanCreateDirectories: true,
        Filters: noteFilter,
      });
      if (selected) {
        setSavePath(selected.endsWith('.tnote') ? selected : `${selected}.tnote`);
      }
    } catch (error) {
      Toast.warning('当前预览环境不可用系统文件对话框，请手动填写路径');
      logFrontend('warn', 'save_dialog_unavailable', { error: String(error) });
    }
  };

  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2">
      <div className="flex items-center gap-3">
        <img className="h-10 w-10 rounded-[8px] object-cover shadow-sm" src={logoUrl} alt="TimeNotes" draggable={false} />
        <div>
          <Typography.Text strong>{document.title}</Typography.Text>
          <div className="text-xs text-black/45">更新于 {updatedAt}</div>
        </div>
      </div>

      <Space className="max-w-full overflow-x-auto">
        <ButtonGroup>
          {toolItems.map((item) => (
            <Tooltip key={item.key} content={item.label}>
              <Button
                type={tool === item.key ? 'primary' : 'tertiary'}
                theme={tool === item.key ? 'solid' : 'light'}
                icon={item.icon}
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
      </Space>

      <Space>
        <ButtonGroup>
          <Tooltip content="撤销">
            <Button icon={<IconUndo />} disabled={!canUndo || activeTabMode !== 'edit'} onClick={undo} />
          </Tooltip>
          <Tooltip content="恢复">
            <Button icon={<IconRedo />} disabled={!canRedo || activeTabMode !== 'edit'} onClick={redo} />
          </Tooltip>
        </ButtonGroup>
        <Button icon={<IconPlus />} onClick={createNewDocument}>
          新建
        </Button>
        <Button icon={<IconFolderOpen />} onClick={() => setOpenVisible(true)}>
          打开
        </Button>
        <Button icon={<IconBookOpenStroked />} onClick={openReadTab}>
          阅读
        </Button>
        <Button type="primary" theme="solid" icon={<IconSave />} disabled={activeTabMode !== 'edit'} onClick={() => setSaveVisible(true)}>
          保存
        </Button>
      </Space>

      <PathModal
        title="保存 .tnote"
        visible={saveVisible}
        value={savePath}
        actionText="保存"
        onChoosePath={chooseSavePath}
        onChange={setSavePath}
        onCancel={() => setSaveVisible(false)}
        onOk={saveNote}
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

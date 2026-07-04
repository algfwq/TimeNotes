import { useCallback, useEffect, useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import { Button, Dropdown, Input, Modal, Toast } from '@douyinfe/semi-ui';
import {
  IconDelete,
  IconDownload,
  IconEdit,
  IconFolderOpen,
  IconHome,
  IconImage,
  IconPlus,
  IconUpload,
} from '@douyinfe/semi-icons';
import { Dialogs } from '@wailsio/runtime';
import { Events } from '@wailsio/runtime';
import * as NotebookService from '../../bindings/changeme/notebookservice';
import type { NotebookMeta } from '../../bindings/changeme/models';
import { logFrontend } from '../lib/logger';
import { useDocument } from '../providers/DocumentProvider';
import { assetDataUrl } from '../lib/files';
import type { NoteElement, NotePackage } from '../types';

const noteFilter = [{ DisplayName: 'TimeNotes 文件', Pattern: '*.tnote' }];

export function HomeWorkspace() {
  const { loadPackage, tabs, switchTab, openNotebookPath } = useDocument();
  const [notebooks, setNotebooks] = useState<NotebookMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [createVisible, setCreateVisible] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renameTarget, setRenameTarget] = useState<NotebookMeta | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<NotebookMeta | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const loadNotebooks = useCallback(async () => {
    try {
      const list = await NotebookService.ListNotebooks();
      setNotebooks(list);
    } catch (error) {
      logFrontend('error', 'home_list_failed', { error: String(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotebooks();
  }, [loadNotebooks]);

  // 检查启动时命令行传入的 .tnote 文件路径。
  useEffect(() => {
    NotebookService.GetStartupFilePath().then((startupPath) => {
      if (!startupPath) {
        return;
      }
      openExternalNote(startupPath);
    }).catch(() => {});
  }, []);

  const openExternalNote = useCallback(async (srcPath: string) => {
    try {
      await openNotebookPath(srcPath);
      await loadNotebooks();
      Toast.success('已打开手账本');
    } catch (error) {
      Toast.error(`打开失败：${String(error)}`);
    }
  }, [loadNotebooks, openNotebookPath]);

  // 监听第二个实例转发的文件打开事件（通过 SingleInstance 机制）。
  useEffect(() => {
    const unsub = Events.On('app:file-open-requested', (data: any) => {
      const args: string[] = Array.isArray(data?.Args) ? data.Args : (data?.args ?? []);
      const filePath = args.find((arg: string) => /\.tnote$/i.test(arg));
      if (filePath) {
        void openExternalNote(filePath);
      }
    });
    return () => unsub();
  }, [openExternalNote]);

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) {
      Toast.warning('请输入手账本名称');
      return;
    }
    try {
      const meta = await NotebookService.CreateNotebook(name);
      setCreateVisible(false);
      setCreateName('');
      const note = (await NotebookService.OpenNotebook(meta.id)) as NotePackage;
      loadPackage(note, meta.path);
      loadNotebooks();
      Toast.success('手账本已创建');
    } catch (error) {
      Toast.error(`创建失败：${String(error)}`);
    }
  }, [createName, loadNotebooks, loadPackage]);

  const handleOpen = useCallback(async (meta: NotebookMeta) => {
    // 检查是否已经打开。
    const existingTab = tabs.find((tab) => tab.sourcePath === meta.path);
    if (existingTab) {
      switchTab(existingTab.id);
      return;
    }
    try {
      const note = (await NotebookService.OpenNotebook(meta.id)) as NotePackage;
      loadPackage(note, meta.path);
      Toast.success('已打开手账本');
    } catch (error) {
      Toast.error(`打开失败：${String(error)}`);
    }
  }, [loadPackage, switchTab, tabs]);

  const handleImport = useCallback(async () => {
    try {
      const selected = await Dialogs.OpenFile({
        Title: '导入手账本',
        CanChooseFiles: true,
        AllowsMultipleSelection: false,
        Filters: noteFilter,
      });
      if (typeof selected === 'string' && selected) {
        const meta = await NotebookService.ImportNotebook(selected);
        const note = (await NotebookService.OpenNotebook(meta.id)) as NotePackage;
        loadPackage(note, meta.path);
        await loadNotebooks();
        Toast.success('手账本已导入并打开');
      }
    } catch (error) {
      logFrontend('warn', 'import_dialog_unavailable', { error: String(error) });
    }
  }, [loadNotebooks, loadPackage]);

  const handleOpenExternal = useCallback(async () => {
    try {
      const selected = await Dialogs.OpenFile({
        Title: '打开手账本',
        CanChooseFiles: true,
        AllowsMultipleSelection: false,
        Filters: noteFilter,
      });
      if (typeof selected === 'string' && selected) {
        await openExternalNote(selected);
      }
    } catch (error) {
      logFrontend('warn', 'open_dialog_unavailable', { error: String(error) });
    }
  }, [openExternalNote]);

  const handleRename = useCallback(async () => {
    if (!renameTarget || !renameName.trim()) {
      return;
    }
    try {
      await NotebookService.RenameNotebook(renameTarget.id, renameName.trim());
      setRenameTarget(null);
      setRenameName('');
      await loadNotebooks();
      Toast.success('已重命名');
    } catch (error) {
      Toast.error(`重命名失败：${String(error)}`);
    }
  }, [renameTarget, renameName, loadNotebooks]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    try {
      await NotebookService.DeleteNotebook(deleteTarget.id);
      setDeleteTarget(null);
      await loadNotebooks();
      Toast.success('手账本已删除');
    } catch (error) {
      Toast.error(`删除失败：${String(error)}`);
    }
  }, [deleteTarget, loadNotebooks]);

  const handleBackup = useCallback(async (meta: NotebookMeta) => {
    try {
      const selected = await Dialogs.SaveFile({
        Title: '备份手账本',
        Filename: `${meta.name}.tnote`,
        CanCreateDirectories: true,
        Filters: noteFilter,
      });
      if (selected) {
        const destPath = selected.endsWith('.tnote') ? selected : `${selected}.tnote`;
        await NotebookService.BackupNotebook(meta.id, destPath);
        Toast.success('备份完成');
      }
    } catch (error) {
      logFrontend('warn', 'backup_dialog_unavailable', { error: String(error) });
    }
  }, []);

  const handleChangeCover = useCallback(async (meta: NotebookMeta) => {
    try {
      const selected = await Dialogs.OpenFile({
        Title: '选择封面图片',
        CanChooseFiles: true,
        AllowsMultipleSelection: false,
        Filters: [{ DisplayName: '图片文件', Pattern: '*.png;*.jpg;*.jpeg;*.webp' }],
      });
      if (typeof selected !== 'string' || !selected) {
        return;
      }
      const dataUrl = await NotebookService.ReadImageAsDataURL(selected);
      await NotebookService.UpdateNotebookCover(meta.id, dataUrl);
      await loadNotebooks();
      Toast.success('封面已更新');
    } catch (error) {
      Toast.error(`更新封面失败：${String(error)}`);
    }
  }, [loadNotebooks]);

  // 拖拽视觉反馈：Wails3 原生文件拖放由 AppShell 统一处理；
  // 这里只保留 DOM 拖放叠加层效果。
  useEffect(() => {
    const handleDrop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !hasTnoteDrag(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setDragActive(true);
    };
    const handleDragEnd = () => setDragActive(false);

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('dragend', handleDragEnd);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('dragend', handleDragEnd);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`relative h-full overflow-y-auto ${dragActive ? 'bg-[#2f6fed]/5' : ''}`}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <div className="rounded-2xl border-2 border-dashed border-[#2f6fed] bg-white/90 px-12 py-16 text-center shadow-2xl">
            <IconUpload size="extra-large" className="mx-auto mb-2 text-[#2f6fed]" />
            <div className="text-lg font-medium text-[#2f6fed]">松开导入手账本</div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* 标题区域 */}
        <div className="mb-8 flex items-center gap-3">
          <IconHome size="extra-large" className="text-[#2f6fed]" />
          <div>
            <h1 className="text-2xl font-bold text-ink">手账本</h1>
            <p className="mt-1 text-sm text-black/45">管理、创建和打开你的 TimeNotes 手账本</p>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="animate-pulse rounded-xl border border-black/10 bg-white p-4">
                <div className="aspect-[3/4] rounded-lg bg-black/5" />
                <div className="mt-3 h-4 w-3/4 rounded bg-black/5" />
                <div className="mt-2 h-3 w-1/2 rounded bg-black/5" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4">
            {/* 新建手账卡片 */}
            <button
              type="button"
              className="group flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#2f6fed]/30 bg-white/60 p-8 text-center transition hover:border-[#2f6fed]/60 hover:bg-white hover:shadow-lg"
              onClick={() => setCreateVisible(true)}
            >
              <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-[#2f6fed]/10 text-[#2f6fed] group-hover:bg-[#2f6fed]/20">
                <IconPlus size="extra-large" />
              </div>
              <div className="font-medium text-[#2f6fed]">新建手账</div>
              <div className="mt-1 text-xs text-black/40">创建空白手账本</div>
            </button>

            {/* 导入 / 打开卡片 */}
            <div className="flex flex-col gap-3 rounded-xl border border-black/10 bg-white/60 p-5">
              <Button
                block
                icon={<IconUpload />}
                theme="light"
                onClick={handleImport}
              >
                导入手账
              </Button>
              <Button
                block
                icon={<IconFolderOpen />}
                theme="light"
                onClick={handleOpenExternal}
              >
                打开外部
              </Button>
              <div className="mt-1 text-center text-xs text-black/35">
                或拖拽 .tnote 到此
              </div>
            </div>

            {/* 已有手账本卡片 */}
            {notebooks.map((meta) => (
              <NotebookCard
                key={meta.id}
                meta={meta}
                onOpen={() => handleOpen(meta)}
                onRename={() => {
                  setRenameTarget(meta);
                  setRenameName(meta.name);
                }}
                onDelete={() => setDeleteTarget(meta)}
                onBackup={() => handleBackup(meta)}
                onChangeCover={() => handleChangeCover(meta)}
                onOpenDir={async () => {
                  try {
                    await NotebookService.OpenFileDirectory(meta.path);
                  } catch {
                    Toast.error('无法打开文件目录');
                  }
                }}
              />
            ))}
          </div>
        )}

        {!loading && notebooks.length === 0 ? (
          <div className="mt-12 text-center text-black/35">
            <IconHome size="extra-large" className="mx-auto mb-3 opacity-30" />
            <p>还没有手账本，点击"新建手账"开始创建</p>
          </div>
        ) : null}
      </div>

      {/* 创建手账 Modal */}
      <Modal
        title="新建手账本"
        visible={createVisible}
        okText="创建"
        cancelText="取消"
        onCancel={() => {
          setCreateVisible(false);
          setCreateName('');
        }}
        onOk={handleCreate}
      >
        <Input
          autoFocus
          placeholder="输入手账本名称"
          value={createName}
          onChange={setCreateName}
          onEnterPress={handleCreate}
        />
      </Modal>

      {/* 重命名 Modal */}
      <Modal
        title="重命名手账本"
        visible={Boolean(renameTarget)}
        okText="确认"
        cancelText="取消"
        onCancel={() => {
          setRenameTarget(null);
          setRenameName('');
        }}
        onOk={handleRename}
      >
        <Input
          autoFocus
          placeholder="输入新名称"
          value={renameName}
          onChange={setRenameName}
          onEnterPress={handleRename}
        />
      </Modal>

      {/* 删除确认 Modal */}
      <Modal
        title="删除手账本"
        visible={Boolean(deleteTarget)}
        okText="删除"
        cancelText="取消"
        okType="danger"
        onCancel={() => setDeleteTarget(null)}
        onOk={handleDelete}
      >
        <p>
          确定要删除手账本「{deleteTarget?.name}」吗？
          {deleteTarget?.isManaged ? '本地文件也将被删除。' : '仅从列表中移除，不会删除文件。'}
        </p>
      </Modal>
    </div>
  );
}

function NotebookCard({
  meta,
  onOpen,
  onRename,
  onDelete,
  onBackup,
  onChangeCover,
  onOpenDir,
}: {
  meta: NotebookMeta;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onBackup: () => void;
  onChangeCover: () => void;
  onOpenDir: () => void;
}) {
  const updatedAt = new Date(meta.updatedAt).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const dropdownMenu = [
    { node: 'item' as const, name: '重命名', icon: <IconEdit />, onClick: onRename },
    { node: 'item' as const, name: '更改封面', icon: <IconImage />, onClick: onChangeCover },
    { node: 'item' as const, name: '备份', icon: <IconDownload />, onClick: onBackup },
    { node: 'item' as const, name: '打开文件目录', icon: <IconFolderOpen />, onClick: onOpenDir },
    { node: 'divider' as const },
    { node: 'item' as const, name: '删除', icon: <IconDelete />, type: 'danger' as const, onClick: onDelete },
  ];

  return (
    <div className="group relative overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm transition hover:shadow-md">
      {/* 封面区域 */}
      <button
        type="button"
        className="block w-full text-left"
        onClick={onOpen}
      >
        <div className="aspect-[3/4] overflow-hidden bg-[#f8f4ea]">
          {meta.coverType === 'custom' && meta.coverData ? (
            <img
              className="h-full w-full object-cover"
              src={meta.coverData}
              alt={meta.name}
            />
          ) : (
            <DefaultCoverPreview meta={meta} />
          )}
        </div>
        {/* 卡片底栏 */}
        <div className="flex items-center justify-between gap-2 p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{meta.name}</div>
            <div className="mt-0.5 text-xs text-black/40">{updatedAt}</div>
          </div>
          {!meta.isManaged ? (
            <span className="shrink-0 rounded-full bg-[#f2cf72]/20 px-2 py-0.5 text-[11px] text-[#9b8422]">
              外部
            </span>
          ) : null}
        </div>
      </button>

      {/* 悬浮操作菜单 */}
      <div className="absolute right-2 top-2 opacity-0 transition group-hover:opacity-100">
        <Dropdown
          menu={dropdownMenu}
          trigger="click"
          position="bottomRight"
        >
          <Button
            size="small"
            theme="borderless"
            type="tertiary"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            }
            onClick={(e) => e.stopPropagation()}
          />
        </Dropdown>
      </div>
    </div>
  );
}

function DefaultCoverPreview({ meta }: { meta: NotebookMeta }) {
  const [preview, setPreview] = useState('');
  const [note, setNote] = useState<NotePackage | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview('');
    setNote(null);
    NotebookService.OpenNotebook(meta.id)
      .then((opened) => {
        if (!cancelled) {
          setNote(opened as NotePackage);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.updatedAt]);

  useEffect(() => {
    if (!note || !previewRef.current) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (!previewRef.current) {
        return;
      }
      try {
        const canvas = await html2canvas(previewRef.current, {
          scale: Math.min(1.5, window.devicePixelRatio || 1),
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#fffaf0',
        });
        if (!cancelled) {
          setPreview(canvas.toDataURL('image/png'));
        }
      } catch {
        // 预览生成失败时保留占位封面。
      }
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [note]);

  if (preview) {
    return <img className="h-full w-full object-cover" src={preview} alt={meta.name} />;
  }

  const page = note?.document.pages[0];
  const elements = page ? note.document.elements.filter((element) => element.pageId === page.id) : [];
  const scale = page ? Math.min(240 / page.width, 340 / page.height) : 1;
  const backgroundAsset = page?.backgroundAssetId ? note?.assets.find((asset) => asset.id === page.backgroundAssetId) : undefined;
  const backgroundSrc = assetDataUrl(backgroundAsset);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#f8f4ea]">
      <div className="pointer-events-none absolute left-0 top-0 opacity-0" style={{ width: 260, height: 360 }}>
        {page ? (
          <div
            ref={previewRef}
            className="relative overflow-hidden bg-[#fffaf0]"
            style={{ width: page.width, height: page.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          >
            <div className="absolute inset-0" style={{ background: page.background || '#fffaf0' }} />
            {backgroundSrc ? (
              <img
                className="pointer-events-none absolute inset-0 h-full w-full"
                src={backgroundSrc}
                alt=""
                draggable={false}
                style={{
                  objectFit: page.backgroundFit ?? 'cover',
                  objectPosition: `${page.backgroundCropX ?? 50}% ${page.backgroundCropY ?? 50}%`,
                }}
              />
            ) : null}
            {elements
              .slice()
              .sort((first, second) => first.zIndex - second.zIndex)
              .map((element) => (
                <DefaultCoverElement key={element.id} element={element} note={note} />
              ))}
          </div>
        ) : null}
      </div>
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
        <IconHome size="large" className="text-black/15" />
        <div className="text-sm font-medium text-black/35 line-clamp-2">{meta.name}</div>
      </div>
    </div>
  );
}

function DefaultCoverElement({ element, note }: { element: NoteElement; note: NotePackage }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${element.rotation}deg)`,
    zIndex: element.zIndex,
    overflow: 'hidden',
  };
  if (element.type === 'text' || element.type === 'code') {
    return (
      <div style={{ ...style, color: String(element.style?.color ?? '#2f2a24'), fontSize: Number(element.style?.fontSize ?? 22), background: String(element.style?.background ?? 'transparent') }}>
        {element.content}
      </div>
    );
  }
  if (element.type === 'image' || element.type === 'sticker') {
    const groups = element.type === 'sticker' ? note.stickers : note.assets;
    const asset = groups.find((item) => item.id === element.assetId);
    const src = assetDataUrl(asset);
    return src ? <img style={{ ...style, objectFit: String(element.style?.fit ?? 'contain') as React.CSSProperties['objectFit'] }} src={src} alt="" draggable={false} /> : null;
  }
  if (element.type === 'drawing' || element.type === 'tape') {
    return null;
  }
  return null;
}

function hasTnoteDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).some(
    (type) => type === 'Files',
  );
}

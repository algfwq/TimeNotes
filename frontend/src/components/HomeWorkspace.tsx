import { useCallback, useEffect, useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import { Button, Dropdown, Input, Modal, Toast } from '@douyinfe/semi-ui';
import {
  IconCloud,
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
import { BlogConnectModal } from './BlogConnectModal';
import {
  loadBlogConnection,
  loadBlogSyncMap,
  updateNotebookOnBlog,
  uploadNotebookToBlog,
  type BlogConnection,
  type BlogSyncEntry,
} from '../lib/blogClient';

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
  const [blogConnectVisible, setBlogConnectVisible] = useState(false);
  const [blogConn, setBlogConn] = useState<BlogConnection | null>(null);
  const [blogSync, setBlogSync] = useState<Record<string, BlogSyncEntry>>({});
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

  useEffect(() => {
    void loadBlogConnection().then(setBlogConn);
    void loadBlogSyncMap().then(setBlogSync);
  }, []);

  const refreshBlogSync = useCallback(async () => {
    setBlogSync(await loadBlogSyncMap());
  }, []);

  const handleUploadBlog = useCallback(async (meta: NotebookMeta) => {
    try {
      const existing = blogSync[meta.id];
      if (existing?.remoteId) {
        await updateNotebookOnBlog(meta.id, existing.remoteId);
        Toast.success('已更新到 Blog');
      } else {
        await uploadNotebookToBlog(meta.id);
        Toast.success('已上传到 Blog');
      }
      await refreshBlogSync();
    } catch (error) {
      Toast.error(`Blog 同步失败：${String(error)}`);
    }
  }, [blogSync, refreshBlogSync]);

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

  // 监听第二个实例/本机 Blog 编辑桥转发的文件打开事件。
  useEffect(() => {
    const unsub = Events.On('app:file-open-requested', (data: any) => {
      // Wails event payloads may be the object itself or nested under data/detail.
      const payload = data?.data ?? data?.detail ?? data ?? {};
      const args: string[] = Array.isArray(payload?.Args)
        ? payload.Args
        : Array.isArray(payload?.args)
          ? payload.args
          : Array.isArray(data?.Args)
            ? data.Args
            : Array.isArray(data?.args)
              ? data.args
              : [];
      const directPath = typeof payload?.path === 'string' ? payload.path : (typeof data?.path === 'string' ? data.path : '');
      const filePath = args.find((arg: string) => /\.tnote$/i.test(String(arg))) || (/\.tnote$/i.test(directPath) ? directPath : '');
      if (filePath) {
        void openExternalNote(String(filePath)).then(() => {
          // Refresh notebook list so the imported Blog note and cloud badge appear immediately.
          void loadNotebooks();
          void loadBlogSyncMap().then(setBlogSync).catch(() => undefined);
        });
      }
    });
    return () => unsub();
  }, [loadNotebooks, openExternalNote]);

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
        <div className="mb-8 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <IconHome size="extra-large" className="text-[#2f6fed]" />
            <div>
              <h1 className="text-2xl font-bold text-ink">手账本</h1>
              <p className="mt-1 text-sm text-black/45">
                管理、创建和打开你的 TimeNotes 手账本
                {blogConn?.url ? ` · 已连接 ${blogConn.url}` : ''}
              </p>
            </div>
          </div>
          <Button
            icon={<IconCloud />}
            theme={blogConn?.token ? 'solid' : 'light'}
            type="primary"
            onClick={() => setBlogConnectVisible(true)}
          >
            {blogConn?.token ? 'Blog 已连接' : '连接到 Blog'}
          </Button>
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
                cloudLinked={Boolean(blogSync[meta.id]?.remoteId)}
                onOpen={() => handleOpen(meta)}
                onRename={() => {
                  setRenameTarget(meta);
                  setRenameName(meta.name);
                }}
                onDelete={() => setDeleteTarget(meta)}
                onBackup={() => handleBackup(meta)}
                onChangeCover={() => handleChangeCover(meta)}
                onUploadBlog={() => handleUploadBlog(meta)}
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
          {deleteTarget && blogSync[deleteTarget.id]?.remoteId
            ? ' 已上云的 Blog 副本不会被删除。'
            : ''}
        </p>
      </Modal>

      <BlogConnectModal
        visible={blogConnectVisible}
        onClose={() => setBlogConnectVisible(false)}
        onConnected={(conn) => setBlogConn(conn)}
      />
    </div>
  );
}

function NotebookCard({
  meta,
  cloudLinked,
  onOpen,
  onRename,
  onDelete,
  onBackup,
  onChangeCover,
  onUploadBlog,
  onOpenDir,
}: {
  meta: NotebookMeta;
  cloudLinked: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onBackup: () => void;
  onChangeCover: () => void;
  onUploadBlog: () => void;
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
    {
      node: 'item' as const,
      name: cloudLinked ? '更新到 Blog' : '上传到 Blog',
      icon: <IconCloud />,
      onClick: onUploadBlog,
    },
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
          <div className="flex shrink-0 items-center gap-1">
            {cloudLinked ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-[#2f6fed]/12 px-2 py-0.5 text-[11px] text-[#2f6fed]"
                title="已上云"
              >
                <IconCloud size="small" />
                上云
              </span>
            ) : null}
            {!meta.isManaged ? (
              <span className="rounded-full bg-[#f2cf72]/20 px-2 py-0.5 text-[11px] text-[#9b8422]">
                外部
              </span>
            ) : null}
          </div>
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
        } as any);
        if (cancelled) {
          return;
        }
        const dataUrl = canvas.toDataURL('image/png');
        setPreview(dataUrl);
        // 无有效自定义封面时，将默认首页预览持久化到元数据与 .tnote thumbnail.png。
        // UpdateNotebookThumbnail 会跳过已有 custom 封面，避免覆盖用户设置。
        try {
          await NotebookService.UpdateNotebookThumbnail(meta.id, dataUrl);
        } catch {
          // 持久化失败不影响本地预览展示。
        }
      } catch {
        // 预览生成失败时保留占位封面。
      }
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [meta.id, note]);

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

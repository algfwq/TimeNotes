import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, Toast, Upload } from '@douyinfe/semi-ui';
import { IconCrop, IconDelete, IconImage, IconMusic, IconPlayCircle, IconUpload, IconVideo } from '@douyinfe/semi-icons';
import { readAudioMetadata } from '../../lib/audioMetadata';
import { readVideoMetadata } from '../../lib/videoMetadata';
import {
  assetCoverDataUrl,
  assetDataUrl,
  assetPosterDataUrl,
  createAssetFromDataUrl,
  createAssetFromFile,
  getImagePlacementSize,
  isGifAsset,
  isSupportedAudioFile,
  isSupportedImageFile,
  isSupportedVideoFile,
  mergeAssetWithCache,
} from '../../lib/files';
import { useDocument } from '../../providers/DocumentProvider';
import { resourceProgressKey, useResourceProgressMap } from '../../providers/ResourceProgressStore';
import { ImageCropModal } from '../ImageCropModal';
import type { AssetMeta } from '../../types';

const materialAccept = '.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.webm,.mp4,.mov,.avi,.mkv,.wmv,image/*,audio/*,video/*';

export function AssetLibrary() {
  const { document, addAsset, addAudio, addVideo, armPlacement, deleteAsset, deleteAudio, deleteVideo, replaceAsset, getResourceAsset } = useDocument();
  const resourceProgress = useResourceProgressMap();
  const [menu, setMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [audioMenu, setAudioMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [videoMenu, setVideoMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [cropAssetId, setCropAssetId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importingFiles, setImportingFiles] = useState<{ name: string; kind: 'image' | 'audio' | 'video' }[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);

  const importImageFile = useCallback(
    async (file: File) => {
      if (!isSupportedImageFile(file)) {
        return;
      }
      const entry = { name: file.name, kind: 'image' as const };
      setImportingFiles((list) => [...list, entry]);
      try {
        const asset = await createAssetFromFile(file, 'assets');
        addAsset(asset);
        Toast.success('素材已导入，点击素材后在画布上放置');
      } catch (error) {
        Toast.error(`素材导入失败：${String(error)}`);
      } finally {
        setImportingFiles((list) => list.filter((item) => item !== entry));
      }
    },
    [addAsset],
  );

  const importAudioFile = useCallback(
    async (file: File) => {
      if (!isSupportedAudioFile(file)) {
        Toast.warning('请选择音频文件');
        return;
      }
      const entry = { name: file.name, kind: 'audio' as const };
      setImportingFiles((list) => [...list, entry]);
      try {
        const [asset, metadata] = await Promise.all([createAssetFromFile(file, 'audios'), readAudioMetadata(file)]);
        addAudio({ ...asset, ...metadata });
        Toast.success('音频已导入，点击后在画布上放置');
      } catch (error) {
        Toast.error(`音频导入失败：${String(error)}`);
      } finally {
        setImportingFiles((list) => list.filter((item) => item !== entry));
      }
    },
    [addAudio],
  );

  const importVideoFile = useCallback(
    async (file: File) => {
      if (!isSupportedVideoFile(file)) {
        Toast.warning('请选择视频文件');
        return;
      }
      const entry = { name: file.name, kind: 'video' as const };
      setImportingFiles((list) => [...list, entry]);
      try {
        const [asset, metadata] = await Promise.all([createAssetFromFile(file, 'videos'), readVideoMetadata(file)]);
        addVideo({ ...asset, ...metadata });
        Toast.success('视频已导入，点击后在画布上放置');
      } catch (error) {
        Toast.error(`视频导入失败：${String(error)}`);
      } finally {
        setImportingFiles((list) => list.filter((item) => item !== entry));
      }
    },
    [addVideo],
  );

  const importMaterialFile = useCallback(
    async (file: File) => {
      if (isSupportedImageFile(file)) {
        await importImageFile(file);
        return;
      }
      if (isSupportedAudioFile(file)) {
        await importAudioFile(file);
        return;
      }
      if (isSupportedVideoFile(file)) {
        await importVideoFile(file);
        return;
      }
      Toast.warning(`不支持的素材：${file.name}`);
    },
    [importAudioFile, importImageFile, importVideoFile],
  );

  const importMaterialFiles = useCallback(
    (files: File[]) => {
      const supported = files.filter(isSupportedMaterialFile);
      if (supported.length === 0) {
        if (files.length > 0) {
          Toast.warning('没有可导入的图片、GIF、音频或视频素材');
        }
        return;
      }
      supported.forEach((file) => void importMaterialFile(file));
    },
    [importMaterialFile],
  );

  useEffect(() => {
    const handleWindowDragOver = (event: DragEvent) => {
      if (!hasFileDrag(event.dataTransfer) || !isEventInsideRoot(event, rootRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setDragActive(true);
    };
    const handleWindowDrop = (event: DragEvent) => {
      if (!hasFileDrag(event.dataTransfer) || !isEventInsideRoot(event, rootRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setDragActive(false);
      importMaterialFiles(filesFromDataTransfer(event.dataTransfer));
    };
    const handleWindowDragEnd = () => {
      dragDepthRef.current = 0;
      setDragActive(false);
    };
    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('drop', handleWindowDrop, true);
    window.addEventListener('dragend', handleWindowDragEnd, true);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('drop', handleWindowDrop, true);
      window.removeEventListener('dragend', handleWindowDragEnd, true);
    };
  }, [importMaterialFiles]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(isSupportedMaterialFile);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      importMaterialFiles(files);
    };
    // 素材栏挂载时监听粘贴，用户无需先点上传按钮即可 Ctrl+V 导入剪切板素材。
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [importMaterialFiles]);

  useEffect(() => {
    const close = () => {
      setMenu(null);
      setAudioMenu(null);
      setVideoMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  const chooseAsset = async (asset: AssetMeta) => {
    const src = assetDataUrl(asset) ?? '';
    const size = src ? await getImagePlacementSize(src, 220, 180).catch(() => ({ width: 220, height: 160, aspectRatio: 220 / 160 })) : { width: 220, height: 160, aspectRatio: 220 / 160 };
    armPlacement({ type: 'image', patch: { assetId: asset.id, width: size.width, height: size.height, style: { fit: 'contain', aspectRatio: size.aspectRatio } } });
    Toast.info('已选择素材，请在画布上点击放置位置');
  };

  const chooseAudio = (asset: AssetMeta) => {
    armPlacement({
      type: 'audio',
      patch: {
        assetId: asset.id,
        width: 360,
        height: 96,
        style: { audioTheme: 'light' },
      },
    });
    Toast.info('已选择音频，请在画布上点击放置位置');
  };

  const chooseVideo = (asset: AssetMeta) => {
    const videoWidth = asset.videoWidth || 640;
    const videoHeight = asset.videoHeight || 360;
    const maxWidth = 560;
    const scale = Math.min(maxWidth / videoWidth, 1);
    const width = Math.max(160, Math.round(videoWidth * scale));
    const height = Math.max(90, Math.round(videoHeight * scale));
    const aspectRatio = videoWidth / Math.max(1, videoHeight);
    armPlacement({
      type: 'video',
      patch: {
        assetId: asset.id,
        width,
        height,
        style: { videoTheme: 'dark', aspectRatio },
      },
    });
    Toast.info('已选择视频，请在画布上点击放置位置');
  };

  const cropAsset = mergeAssetWithCache(document.assets.find((asset) => asset.id === cropAssetId), getResourceAsset(cropAssetId ?? undefined));
  const cropSrc = cropAsset && !isGifAsset(cropAsset) ? assetDataUrl(cropAsset) : undefined;
  const menuAsset = menu ? mergeAssetWithCache(document.assets.find((asset) => asset.id === menu.assetId), getResourceAsset(menu.assetId)) : undefined;
  const hasAnyAsset = document.assets.length > 0 || document.audios.length > 0 || document.videos.length > 0;
  const applyAssetCrop = async (dataUrl: string) => {
    if (cropAsset && !isGifAsset(cropAsset)) {
      const nextAsset = await createAssetFromDataUrl(dataUrl, `${cropAsset.name}-裁剪.png`, 'assets', 'image/png');
      replaceAsset(cropAsset.id, nextAsset);
      Toast.success('素材已裁剪');
    }
    setCropAssetId(null);
  };

  return (
    <div
      ref={rootRef}
      className={`relative h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4 ${dragActive ? 'bg-[#2f6fed]/5' : ''}`}
      tabIndex={0}
      onDragEnter={(event) => {
        if (!hasFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!hasFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (!hasFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setDragActive(false);
        }
      }}
      onDrop={(event) => {
        if (!hasFileDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        dragDepthRef.current = 0;
        setDragActive(false);
        importMaterialFiles(filesFromDataTransfer(event.dataTransfer));
      }}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-2 z-[20] grid place-items-center rounded-[8px] border-2 border-dashed border-[#2f6fed] bg-white/78 text-sm font-medium text-[#2f6fed] shadow-sm">
          松开导入素材
        </div>
      ) : null}
      <Upload
        action=""
        accept={materialAccept}
        multiple
        showUploadList={false}
        uploadTrigger="custom"
        onFileChange={(files: unknown[]) => {
          importMaterialFiles(files.map(nativeFileFromUploadItem).filter((file): file is File => Boolean(file)));
        }}
      >
        <Button block theme="solid" type="primary" icon={<IconUpload />}>
          导入素材
        </Button>
      </Upload>

      <div className="mt-2 text-xs text-black/45">可直接 Ctrl+V 粘贴剪切板素材</div>

      {importingFiles.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {importingFiles.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-3 rounded-[8px] border border-dashed border-[#2f6fed]/30 bg-[#2f6fed]/5 px-3 py-2"
            >
              <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#2f6fed]/30 border-t-[#2f6fed]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-black/70">{entry.name}</div>
                <div className="text-[11px] text-black/40">
                  {entry.kind === 'video' ? '正在解析视频...' : entry.kind === 'audio' ? '正在解析音频...' : '正在导入素材...'}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {document.assets.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {document.assets.map((asset) => {
            const hydratedAsset = mergeAssetWithCache(asset, getResourceAsset(asset.id)) ?? asset;
            const progress = resourceProgress[resourceProgressKey('assets', asset.id)];
            const src = assetDataUrl(hydratedAsset);
            return (
              <button
                key={asset.id}
                className="group overflow-hidden rounded-[8px] border border-black/10 bg-white p-2 text-left shadow-sm transition hover:border-[#2f6fed]/45"
                type="button"
                onClick={() => void chooseAsset(hydratedAsset)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenu({ x: event.clientX, y: event.clientY, assetId: asset.id });
                }}
              >
                <div className="aspect-[4/3] overflow-hidden rounded-[6px] bg-transparent">
                  {src ? <img className="h-full w-full object-contain" src={src} alt="" /> : <IconImage className="m-auto mt-8 text-black/30" />}
                </div>
                {progress ? (
                  <div className="mt-2">
                    <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                      <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-black/40">传输中 {Math.round(progress.progress * 100)}%</div>
                  </div>
                ) : null}
                <div className="mt-2 truncate text-xs text-black/60">{hydratedAsset.name}</div>
              </button>
            );
          })}
        </div>
      ) : null}

      {document.audios.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          {document.audios.map((asset) => {
            const hydratedAsset = mergeAssetWithCache(asset, getResourceAsset(asset.id)) ?? asset;
            const cover = assetCoverDataUrl(hydratedAsset);
            const progress = resourceProgress[resourceProgressKey('audios', asset.id)];
            const audioMeta = [hydratedAsset.audioArtist || hydratedAsset.audioAlbum, formatDuration(hydratedAsset.duration)].filter(Boolean).join(' · ');
            return (
              <button
                key={asset.id}
                type="button"
                className="group flex min-w-0 items-center gap-3 rounded-[8px] border border-black/10 bg-white p-2 text-left shadow-sm transition hover:border-[#2f6fed]/45"
                onClick={() => chooseAudio(hydratedAsset)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setAudioMenu({ x: event.clientX, y: event.clientY, assetId: asset.id });
                }}
              >
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-[#111827] text-white">
                  {cover ? <img className="h-full w-full object-cover" src={cover} alt="" /> : <IconMusic />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{hydratedAsset.audioTitle || hydratedAsset.name}</div>
                  <div className="truncate text-xs text-black/45">{audioMeta || '未知时长'}</div>
                  {progress ? (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                        <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-black/40">传输中 {Math.round(progress.progress * 100)}%</div>
                    </div>
                  ) : null}
                </div>
                <IconPlayCircle className="shrink-0 text-black/28 group-hover:text-[#2f6fed]" />
              </button>
            );
          })}
        </div>
      ) : null}

      {document.videos.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          {document.videos.map((asset) => {
            const hydratedAsset = mergeAssetWithCache(asset, getResourceAsset(asset.id)) ?? asset;
            const cover = assetCoverDataUrl(hydratedAsset) || assetPosterDataUrl(hydratedAsset);
            const progress = resourceProgress[resourceProgressKey('videos', asset.id)];
            const durationText = formatDuration(hydratedAsset.duration);
            return (
              <button
                key={asset.id}
                type="button"
                className="group flex min-w-0 items-center gap-3 rounded-[8px] border border-black/10 bg-white p-2 text-left shadow-sm transition hover:border-[#2f6fed]/45"
                onClick={() => chooseVideo(hydratedAsset)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setVideoMenu({ x: event.clientX, y: event.clientY, assetId: asset.id });
                }}
              >
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-[#111827] text-white">
                  {cover ? <img className="h-full w-full object-cover" src={cover} alt="" /> : <IconVideo />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{hydratedAsset.name}</div>
                  <div className="truncate text-xs text-black/45">{durationText || '未知时长'}</div>
                  {progress ? (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                        <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-black/40">传输中 {Math.round(progress.progress * 100)}%</div>
                    </div>
                  ) : null}
                </div>
                <IconPlayCircle className="shrink-0 text-black/28 group-hover:text-[#2f6fed]" />
              </button>
            );
          })}
        </div>
      ) : null}

      {!hasAnyAsset ? (
        <div className="mt-10 rounded-[8px] border border-dashed border-black/15 bg-white/60 py-8">
          <Empty image={<IconImage size="extra-large" />} description="还没有导入素材" />
        </div>
      ) : null}
      <AssetContextMenu
        state={menu}
        canCrop={Boolean(menuAsset && !isGifAsset(menuAsset))}
        onCrop={(assetId) => {
          const asset = document.assets.find((item) => item.id === assetId);
          if (!asset || isGifAsset(asset)) {
            setMenu(null);
            return;
          }
          setCropAssetId(assetId);
          setMenu(null);
        }}
        onDelete={(assetId) => {
          deleteAsset(assetId);
          setMenu(null);
          Toast.success('素材已删除');
        }}
      />
      <AudioContextMenu
        state={audioMenu}
        onDelete={(assetId) => {
          deleteAudio(assetId);
          setAudioMenu(null);
          Toast.success('音频已删除');
        }}
      />
      <VideoContextMenu
        state={videoMenu}
        onDelete={(assetId) => {
          deleteVideo(assetId);
          setVideoMenu(null);
          Toast.success('视频已删除');
        }}
      />
      <ImageCropModal title="裁剪素材" visible={Boolean(cropSrc)} src={cropSrc} onClose={() => setCropAssetId(null)} onApply={applyAssetCrop} />
    </div>
  );
}

function AssetContextMenu({
  state,
  canCrop,
  onCrop,
  onDelete,
}: {
  state: { x: number; y: number; assetId: string } | null;
  canCrop: boolean;
  onCrop: (assetId: string) => void;
  onDelete: (assetId: string) => void;
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
      {canCrop ? (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5" onClick={() => onCrop(state.assetId)}>
          <IconCrop />
          <span>裁剪素材</span>
        </button>
      ) : null}
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-black/5" onClick={() => onDelete(state.assetId)}>
        <IconDelete />
        <span>删除素材</span>
      </button>
    </div>
  );
}

function isSupportedMaterialFile(file: Pick<File, 'type' | 'name'>) {
  return isSupportedImageFile(file) || isSupportedAudioFile(file) || isSupportedVideoFile(file);
}

function hasFileDrag(dataTransfer?: DataTransfer | null) {
  if (!dataTransfer) {
    return false;
  }
  if (dataTransfer.files?.length || Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) {
    return true;
  }
  return Array.from(dataTransfer.types ?? []).some((type) => type.toLowerCase() === 'files');
}

function filesFromDataTransfer(dataTransfer?: DataTransfer | null) {
  if (!dataTransfer) {
    return [];
  }
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) {
    return files;
  }
  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function nativeFileFromUploadItem(item: unknown) {
  if (item instanceof File) {
    return item;
  }
  const candidate = item as { fileInstance?: File; originFileObj?: File; file?: File };
  return candidate.fileInstance ?? candidate.originFileObj ?? candidate.file;
}

function isEventInsideRoot(event: Event, root: HTMLElement | null) {
  if (!root) {
    return false;
  }
  const path = event.composedPath?.() ?? [];
  return path.includes(root) || (event.target instanceof Node && root.contains(event.target));
}

function AudioContextMenu({ state, onDelete }: { state: { x: number; y: number; assetId: string } | null; onDelete: (assetId: string) => void }) {
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
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-black/5" onClick={() => onDelete(state.assetId)}>
        <IconDelete />
        <span>删除音频</span>
      </button>
    </div>
  );
}

function VideoContextMenu({ state, onDelete }: { state: { x: number; y: number; assetId: string } | null; onDelete: (assetId: string) => void }) {
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
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-black/5" onClick={() => onDelete(state.assetId)}>
        <IconDelete />
        <span>删除视频</span>
      </button>
    </div>
  );
}

function formatDuration(value?: number) {
  if (!value) {
    return '';
  }
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

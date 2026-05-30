import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Toast, Upload } from '@douyinfe/semi-ui';
import { IconCrop, IconDelete, IconImage, IconMusic, IconPlayCircle, IconUpload } from '@douyinfe/semi-icons';
import { readAudioMetadata } from '../../lib/audioMetadata';
import {
  assetCoverDataUrl,
  assetDataUrl,
  createAssetFromDataUrl,
  createAssetFromFile,
  getImagePlacementSize,
  isGifAsset,
  isSupportedAudioFile,
  isSupportedImageFile,
} from '../../lib/files';
import { resourceKey, useDocument } from '../../providers/DocumentProvider';
import { ImageCropModal } from '../ImageCropModal';
import type { AssetMeta } from '../../types';

const audioAccept = '.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.webm,audio/*';

export function AssetLibrary() {
  const { document, addAsset, addAudio, armPlacement, deleteAsset, deleteAudio, replaceAsset, resourceProgress } = useDocument();
  const [menu, setMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [audioMenu, setAudioMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [cropAssetId, setCropAssetId] = useState<string | null>(null);

  const importImageFile = useCallback(
    async (file: File) => {
      if (!isSupportedImageFile(file)) {
        return;
      }
      const asset = await createAssetFromFile(file, 'assets');
      addAsset(asset);
      Toast.success('素材已导入，点击素材后在画布上放置');
    },
    [addAsset],
  );

  const importAudioFile = useCallback(
    async (file: File) => {
      if (!isSupportedAudioFile(file)) {
        Toast.warning('请选择音频文件');
        return;
      }
      try {
        const [asset, metadata] = await Promise.all([createAssetFromFile(file, 'audios'), readAudioMetadata(file)]);
        addAudio({ ...asset, ...metadata });
        Toast.success('音频已导入，点击后在画布上放置');
      } catch (error) {
        Toast.error(`音频导入失败：${String(error)}`);
      }
    },
    [addAudio],
  );

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(isSupportedImageFile);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      files.forEach((file) => void importImageFile(file));
    };
    // 素材栏挂载时监听粘贴，用户无需先点上传按钮即可 Ctrl+V 导入剪切板图片。
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [importImageFile]);

  useEffect(() => {
    const close = () => {
      setMenu(null);
      setAudioMenu(null);
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

  const cropAsset = document.assets.find((asset) => asset.id === cropAssetId);
  const cropSrc = cropAsset && !isGifAsset(cropAsset) ? assetDataUrl(cropAsset) : undefined;
  const menuAsset = menu ? document.assets.find((asset) => asset.id === menu.assetId) : undefined;
  const hasAnyAsset = document.assets.length > 0 || document.audios.length > 0;
  const applyAssetCrop = async (dataUrl: string) => {
    if (cropAsset && !isGifAsset(cropAsset)) {
      const nextAsset = await createAssetFromDataUrl(dataUrl, `${cropAsset.name}-裁剪.png`, 'assets', 'image/png');
      replaceAsset(cropAsset.id, nextAsset);
      Toast.success('素材已裁剪');
    }
    setCropAssetId(null);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4" tabIndex={0}>
      <div className="grid grid-cols-2 gap-2">
        <Upload
          action=""
          accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
          multiple
          showUploadList={false}
          uploadTrigger="custom"
          onFileChange={(files: File[]) => {
            files.forEach((file) => void importImageFile(file));
          }}
        >
          <Button block theme="solid" type="primary" icon={<IconUpload />}>
            导入图片
          </Button>
        </Upload>
        <Upload
          action=""
          accept={audioAccept}
          multiple
          showUploadList={false}
          uploadTrigger="custom"
          onFileChange={(files: File[]) => {
            files.forEach((file) => void importAudioFile(file));
          }}
        >
          <Button block icon={<IconMusic />}>
            导入音频
          </Button>
        </Upload>
      </div>

      <div className="mt-2 text-xs text-black/45">可直接 Ctrl+V 粘贴剪切板图片</div>

      {document.assets.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {document.assets.map((asset) => {
            const progress = resourceProgress[resourceKey('assets', asset.id)];
            const src = assetDataUrl(asset);
            return (
              <button
                key={asset.id}
                className="group overflow-hidden rounded-[8px] border border-black/10 bg-white p-2 text-left shadow-sm transition hover:border-[#2f6fed]/45"
                type="button"
                onClick={() => void chooseAsset(asset)}
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
                <div className="mt-2 truncate text-xs text-black/60">{asset.name}</div>
              </button>
            );
          })}
        </div>
      ) : null}

      {document.audios.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          {document.audios.map((asset) => {
            const cover = assetCoverDataUrl(asset);
            const progress = resourceProgress[resourceKey('audios', asset.id)];
            const audioMeta = [asset.audioArtist || asset.audioAlbum, formatDuration(asset.duration)].filter(Boolean).join(' · ');
            return (
              <button
                key={asset.id}
                type="button"
                className="group flex min-w-0 items-center gap-3 rounded-[8px] border border-black/10 bg-white p-2 text-left shadow-sm transition hover:border-[#2f6fed]/45"
                onClick={() => chooseAudio(asset)}
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
                  <div className="truncate text-sm font-medium">{asset.audioTitle || asset.name}</div>
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

function formatDuration(value?: number) {
  if (!value) {
    return '';
  }
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Toast, Upload } from '@douyinfe/semi-ui';
import { IconCrop, IconDelete, IconImage, IconUpload } from '@douyinfe/semi-icons';
import { createAssetFromDataUrl, createAssetFromFile } from '../../lib/files';
import { useDocument } from '../../providers/DocumentProvider';
import { ImageCropModal } from '../ImageCropModal';
import type { AssetMeta } from '../../types';

export function AssetLibrary() {
  const { document, addAsset, armPlacement, deleteAsset, replaceAsset } = useDocument();
  const [menu, setMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [cropAssetId, setCropAssetId] = useState<string | null>(null);

  const importFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
        return;
      }
      const asset = await createAssetFromFile(file, 'assets');
      addAsset(asset);
      Toast.success('素材已导入，点击素材后在画布上放置');
    },
    [addAsset],
  );

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      files.forEach((file) => void importFile(file));
    };
    // 素材栏挂载时监听粘贴，用户无需先点上传按钮即可 Ctrl+V 导入剪切板图片。
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [importFile]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  const chooseAsset = (asset: AssetMeta) => {
    armPlacement({ type: 'image', patch: { assetId: asset.id, width: 220, height: 160, style: { fit: 'contain' } } });
    Toast.info('已选择素材，请在画布上点击放置位置');
  };

  const cropAsset = document.assets.find((asset) => asset.id === cropAssetId);
  const cropSrc = cropAsset?.dataUrl ?? (cropAsset?.dataBase64 ? `data:${cropAsset.mimeType};base64,${cropAsset.dataBase64}` : undefined);
  const applyAssetCrop = async (dataUrl: string) => {
    if (cropAsset) {
      const nextAsset = await createAssetFromDataUrl(dataUrl, `${cropAsset.name}-裁剪.png`, 'assets', 'image/png');
      replaceAsset(cropAsset.id, nextAsset);
      Toast.success('素材已裁剪');
    }
    setCropAssetId(null);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4" tabIndex={0}>
      <Upload
        action=""
        accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
        multiple
        showUploadList={false}
        uploadTrigger="custom"
        onFileChange={(files: File[]) => {
          files.forEach((file) => void importFile(file));
        }}
      >
        <Button block theme="solid" type="primary" icon={<IconUpload />}>
          导入图片素材
        </Button>
      </Upload>

      <div className="mt-2 text-xs text-black/45">可直接 Ctrl+V 粘贴剪切板图片</div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {document.assets.map((asset) => (
          <button
            key={asset.id}
            className="group overflow-hidden rounded-[8px] border border-black/10 bg-white p-2 text-left shadow-sm"
            type="button"
            onClick={() => chooseAsset(asset)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({ x: event.clientX, y: event.clientY, assetId: asset.id });
            }}
          >
            <div className="aspect-[4/3] overflow-hidden rounded-[6px] bg-transparent">
              <img className="h-full w-full object-contain" src={asset.dataUrl ?? `data:${asset.mimeType};base64,${asset.dataBase64}`} alt="" />
            </div>
            <div className="mt-2 truncate text-xs text-black/60">{asset.name}</div>
          </button>
        ))}
      </div>

      {document.assets.length === 0 ? (
        <div className="mt-10 rounded-[8px] border border-dashed border-black/15 bg-white/60 py-8">
          <Empty image={<IconImage size="extra-large" />} description="还没有导入素材" />
        </div>
      ) : null}
      <AssetContextMenu
        state={menu}
        onCrop={(assetId) => {
          setCropAssetId(assetId);
          setMenu(null);
        }}
        onDelete={(assetId) => {
          deleteAsset(assetId);
          setMenu(null);
          Toast.success('素材已删除');
        }}
      />
      <ImageCropModal title="裁剪素材" visible={Boolean(cropSrc)} src={cropSrc} onClose={() => setCropAssetId(null)} onApply={applyAssetCrop} />
    </div>
  );
}

function AssetContextMenu({
  state,
  onCrop,
  onDelete,
}: {
  state: { x: number; y: number; assetId: string } | null;
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
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5" onClick={() => onCrop(state.assetId)}>
        <IconCrop />
        <span>裁剪素材</span>
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-black/5" onClick={() => onDelete(state.assetId)}>
        <IconDelete />
        <span>删除素材</span>
      </button>
    </div>
  );
}

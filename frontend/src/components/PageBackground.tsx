import type { AssetMeta, NotePage } from '../types';
import { assetDataUrl } from '../lib/files';
import { resourceKey, useDocument } from '../providers/DocumentProvider';

export function PageBackground({ page, assets }: { page: NotePage; assets: AssetMeta[] }) {
  // 背景图只保存 assetId 和裁剪百分比；图片二进制仍走 assets 打包进 .tnote。
  const { resourceProgress } = useDocument();
  const asset = assets.find((item) => item.id === page.backgroundAssetId);
  const src = assetDataUrl(asset);
  if (!src) {
    const progress = page.backgroundAssetId ? resourceProgress[resourceKey('assets', page.backgroundAssetId)] : undefined;
    if (progress) {
      return (
        <div className="pointer-events-none absolute inset-x-4 top-4 z-[1] rounded-[8px] bg-white/75 px-2 py-1 shadow-sm">
          <div className="mb-1 text-[11px] text-black/55">背景素材传输中 {Math.round(progress.progress * 100)}%</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
            <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
          </div>
        </div>
      );
    }
    return null;
  }
  return (
    <img
      className="pointer-events-none absolute inset-0 h-full w-full"
      src={src}
      alt=""
      draggable={false}
      style={{
        objectFit: page.backgroundFit ?? 'cover',
        objectPosition: `${page.backgroundCropX ?? 50}% ${page.backgroundCropY ?? 50}%`,
      }}
    />
  );
}

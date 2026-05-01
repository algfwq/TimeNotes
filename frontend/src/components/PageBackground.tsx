import type { AssetMeta, NotePage } from '../types';

export function PageBackground({ page, assets }: { page: NotePage; assets: AssetMeta[] }) {
  // 背景图只保存 assetId 和裁剪百分比；图片二进制仍走 assets 打包进 .tnote。
  const asset = assets.find((item) => item.id === page.backgroundAssetId);
  const src = asset?.dataUrl ?? (asset?.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);
  if (!src) {
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

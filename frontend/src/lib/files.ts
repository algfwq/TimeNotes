import type { AssetMeta } from '../types';
import { dataUrlToBase64 } from './base64';
import { createId, hashText } from './ids';

export interface ImageIntrinsicSize {
  width: number;
  height: number;
  aspectRatio: number;
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function assetDataUrl(asset?: Pick<AssetMeta, 'mimeType' | 'dataBase64' | 'dataUrl'> | null) {
  if (!asset) {
    return undefined;
  }
  if (asset.dataUrl) {
    return asset.dataUrl;
  }
  if (asset.dataBase64) {
    return `data:${asset.mimeType || 'application/octet-stream'};base64,${asset.dataBase64}`;
  }
  return undefined;
}

export function isGifAsset(asset?: Pick<AssetMeta, 'mimeType' | 'name' | 'path'> | null) {
  if (!asset) {
    return false;
  }
  return /^image\/gif(?:;|$)/i.test(asset.mimeType || '') || /\.(gif)$/i.test(asset.name || '') || /\.(gif)$/i.test(asset.path || '');
}

export function isSupportedImageFile(file: Pick<File, 'type' | 'name'>) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
}

export function getImageIntrinsicSize(src: string): Promise<ImageIntrinsicSize> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        reject(new Error('图片尺寸不可用'));
        return;
      }
      resolve({ width, height, aspectRatio: width / height });
    };
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

export async function getImagePlacementSize(src: string, maxWidth: number, maxHeight: number): Promise<ImageIntrinsicSize> {
  const intrinsic = await getImageIntrinsicSize(src);
  const scale = Math.min(maxWidth / intrinsic.width, maxHeight / intrinsic.height, 1);
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
    aspectRatio: intrinsic.aspectRatio,
  };
}

// 前端导入图片和字体都走同一套资源结构，保存 .tnote 时后端会把 dataBase64 写入 ZIP 包。
export async function createAssetFromFile(file: File, group: 'assets' | 'stickers' | 'fonts'): Promise<AssetMeta> {
  const dataUrl = await readFileAsDataURL(file);
  return createAssetFromDataUrl(dataUrl, file.name, group, file.type || mimeTypeFromName(file.name), file.size);
}

export async function createAssetFromUrl(url: string, name: string, group: 'assets' | 'stickers' | 'fonts'): Promise<AssetMeta> {
  const response = await fetch(url);
  const blob = await response.blob();
  const dataUrl = await blobToDataURL(blob);
  return createAssetFromDataUrl(dataUrl, name, group, blob.type || mimeTypeFromName(name), blob.size);
}

// Cropper 输出的是 data URL，这里把裁剪后的图片重新包装为普通素材，后续保存仍会写入 .tnote。
export async function createAssetFromDataUrl(
  dataUrl: string,
  name: string,
  group: 'assets' | 'stickers' | 'fonts',
  mimeType = mimeTypeFromDataUrl(dataUrl) || mimeTypeFromName(name),
  size = dataUrl.length,
): Promise<AssetMeta> {
  const hash = await hashText(dataUrl);
  const id = hash.slice(0, 16) || createId(group === 'fonts' ? 'font' : group === 'stickers' ? 'sticker' : 'asset');
  return {
    id,
    name,
    hash,
    mimeType,
    size,
    path: `${group}/${hash}-${name}`,
    dataBase64: dataUrlToBase64(dataUrl),
    dataUrl,
  };
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function mimeTypeFromDataUrl(value: string) {
  const match = /^data:([^;,]+)[;,]/.exec(value);
  return match?.[1] ?? '';
}

export function mimeTypeFromName(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.woff2')) {
    return 'font/woff2';
  }
  if (lower.endsWith('.woff')) {
    return 'font/woff';
  }
  if (lower.endsWith('.otf')) {
    return 'font/otf';
  }
  if (lower.endsWith('.ttf')) {
    return 'font/ttf';
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

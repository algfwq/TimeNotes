import type { AssetMeta } from '../types';
import { dataUrlToBase64 } from './base64';
import { createId, hashText } from './ids';

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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

function mimeTypeFromName(name: string) {
  const lower = name.toLowerCase();
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

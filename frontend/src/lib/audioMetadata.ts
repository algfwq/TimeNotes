import { parseBlob, selectCover } from 'music-metadata';
import type { AssetMeta } from '../types';
import { bytesToBase64 } from './base64';

export async function readAudioMetadata(file: File): Promise<Partial<AssetMeta>> {
  try {
    const metadata = await parseBlob(file, { duration: true });
    const cover = selectCover(metadata.common.picture);
    const coverDataBase64 = cover?.data ? bytesToBase64(cover.data) : undefined;
    const title = metadata.common.title?.trim() || stripAudioExtension(file.name);
    return {
      audioTitle: title,
      audioArtist: metadata.common.artist?.trim() || metadata.common.artists?.filter(Boolean).join(', ') || '',
      audioAlbum: metadata.common.album?.trim() || '',
      duration: metadata.format.duration ? Number(metadata.format.duration.toFixed(3)) : undefined,
      coverMimeType: cover?.format,
      coverDataBase64,
      coverDataUrl: coverDataBase64 ? `data:${cover?.format || 'image/jpeg'};base64,${coverDataBase64}` : undefined,
    };
  } catch {
    return {
      audioTitle: stripAudioExtension(file.name),
      audioArtist: '',
      audioAlbum: '',
    };
  }
}

function stripAudioExtension(name: string) {
  return name.replace(/\.(mp3|m4a|aac|wav|ogg|oga|flac|webm)$/i, '').trim() || name;
}

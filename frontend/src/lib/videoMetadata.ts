import type { AssetMeta } from '../types';

export async function readVideoMetadata(file: File): Promise<Partial<AssetMeta>> {
  try {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    const meta = await new Promise<{ duration: number; videoWidth: number; videoHeight: number }>((resolve, reject) => {
      const cleanup = () => {
        URL.revokeObjectURL(url);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        const result = {
          duration: video.duration || 0,
          videoWidth: video.videoWidth || 0,
          videoHeight: video.videoHeight || 0,
        };
        cleanup();
        resolve(result);
      };
      const onError = () => {
        cleanup();
        reject(new Error('无法读取视频元数据'));
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
      video.src = url;
    });

    const poster = await extractPoster(video, meta.duration);

    return {
      duration: meta.duration ? Number(meta.duration.toFixed(3)) : undefined,
      videoWidth: meta.videoWidth || undefined,
      videoHeight: meta.videoHeight || undefined,
      coverMimeType: poster ? 'image/jpeg' : undefined,
      coverDataBase64: poster,
      coverDataUrl: poster ? `data:image/jpeg;base64,${poster}` : undefined,
    };
  } catch {
    return {
      duration: undefined,
      videoWidth: undefined,
      videoHeight: undefined,
    };
  }
}

async function extractPoster(video: HTMLVideoElement, duration: number): Promise<string | undefined> {
  if (!video.videoWidth || !video.videoHeight) {
    return undefined;
  }
  try {
    const seekTime = Math.min(1, duration * 0.1);
    return await new Promise<string | undefined>((resolve) => {
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(video.videoWidth, 320);
        canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(undefined);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        const parts = dataUrl.split(',');
        resolve(parts.length === 2 ? parts[1] : undefined);
      };
      const onError = () => {
        cleanup();
        resolve(undefined);
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.currentTime = seekTime;
    });
  } catch {
    return undefined;
  }
}

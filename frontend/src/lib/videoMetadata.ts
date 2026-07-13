import type { AssetMeta } from '../types';
import { isMobile } from './platform';

const META_TIMEOUT_MS = 4_000;
const POSTER_TIMEOUT_MS = 1_500;

/**
 * 读取视频时长/尺寸/封面。
 * Android WebView 上 seek 取帧容易卡住，且 blob URL 过早 revoke 会导致 seek 永不完成。
 */
export async function readVideoMetadata(file: File): Promise<Partial<AssetMeta>> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  // 避免部分 WebView 尝试跨域策略
  video.setAttribute('playsinline', 'true');

  try {
    const meta = await withTimeout(
      loadVideoMetadata(video, url),
      META_TIMEOUT_MS,
      '视频元数据读取超时',
    );

    // 移动端优先快路径：不 seek 取帧（seek 在 Android WebView 上经常挂死/极慢）。
    // 桌面仍尝试封面，提升素材库观感。
    let poster: string | undefined;
    if (!isMobile() && meta.videoWidth > 0 && meta.videoHeight > 0) {
      poster = await withTimeout(extractPoster(video, meta.duration), POSTER_TIMEOUT_MS, 'poster').catch(() => undefined);
    }

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
  } finally {
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      // ignore
    }
    URL.revokeObjectURL(url);
  }
}

function loadVideoMetadata(
  video: HTMLVideoElement,
  url: string,
): Promise<{ duration: number; videoWidth: number; videoHeight: number }> {
  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve({
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        videoWidth: video.videoWidth || 0,
        videoHeight: video.videoHeight || 0,
      });
    };
    const onError = () => {
      cleanup();
      reject(new Error('无法读取视频元数据'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
    video.src = url;
  });
}

async function extractPoster(video: HTMLVideoElement, duration: number): Promise<string | undefined> {
  if (!video.videoWidth || !video.videoHeight) {
    return undefined;
  }
  // 优先用当前帧（通常为 0）；避免无必要 seek。
  if (video.readyState >= 2) {
    const frame = captureFrame(video);
    if (frame) {
      return frame;
    }
  }
  const seekTime = Number.isFinite(duration) && duration > 0 ? Math.min(0.5, duration * 0.05) : 0;
  await seekVideo(video, seekTime);
  return captureFrame(video);
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs((video.currentTime || 0) - time) < 0.05 && video.readyState >= 2) {
      resolve();
      return;
    }
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('seek failed'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try {
      video.currentTime = time;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function captureFrame(video: HTMLVideoElement): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    const maxW = 240;
    canvas.width = Math.min(video.videoWidth, maxW);
    canvas.height = Math.max(1, Math.round(canvas.width * (video.videoHeight / Math.max(1, video.videoWidth))));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return undefined;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
    const parts = dataUrl.split(',');
    return parts.length === 2 ? parts[1] : undefined;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

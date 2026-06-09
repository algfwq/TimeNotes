import { useMemo, useRef } from 'react';
import { VideoPlayer } from '@douyinfe/semi-ui';
import { IconPlay, IconVideo } from '@douyinfe/semi-icons';
import { Toast } from '@douyinfe/semi-ui';
import type { AssetMeta, NoteElement, ResourceTransferProgress } from '../../types';
import { assetCoverDataUrl, assetDataUrl, assetPosterDataUrl } from '../../lib/files';

export function VideoElement({
  element,
  asset,
  progress,
  readOnly = false,
}: {
  element: NoteElement;
  asset?: AssetMeta;
  progress?: ResourceTransferProgress;
  readOnly?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const src = assetDataUrl(asset);
  const cover = assetCoverDataUrl(asset) || assetPosterDataUrl(asset);
  const mode = useMemo(() => videoMode(element.width, element.height), [element.height, element.width]);
  const theme = String(element.style?.videoTheme ?? 'dark') === 'light' ? 'light' : 'dark';
  const loop = Boolean(element.style?.loop ?? false);
  const muted = Boolean(element.style?.muted ?? false);
  const loadedProgress = progress?.progress ?? 0;
  const transferPercent = Math.round(loadedProgress * 100);

  const stopInteractiveEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  if (!src) {
    return (
      <div
        className={`timenotes-video-placeholder timenotes-video-${theme} timenotes-video-${mode}`}
        data-video-player
        onPointerDownCapture={readOnly ? stopInteractiveEvent : undefined}
        onWheel={stopInteractiveEvent}
      >
        <div className="timenotes-video-poster">
          {cover ? (
            <img className="h-full w-full object-cover" src={cover} alt="" draggable={false} />
          ) : (
            <IconVideo className="text-white/50" size="large" />
          )}
        </div>
        <div className="timenotes-video-missing-overlay">
          <button
            type="button"
            className="timenotes-video-play-btn"
            data-video-interactive
            onClick={(event) => {
              event.stopPropagation();
              Toast.warning(progress ? `视频素材正在传输（${transferPercent}%），完成后可播放` : '视频素材尚未传输完成');
            }}
          >
            <IconPlay size="large" />
          </button>
          {progress ? (
            <div className="timenotes-video-transfer-info">
              <div className="timenotes-video-transfer-bar">
                <div style={{ width: `${Math.max(8, transferPercent)}%` }} />
              </div>
              <span className="timenotes-video-transfer-text">{transferPercent}%</span>
            </div>
          ) : (
            <div className="timenotes-video-transfer-text">等待同步</div>
          )}
        </div>
      </div>
    );
  }

  if (readOnly) {
    return (
      <div
        className={`timenotes-video-player timenotes-video-${theme}`}
        data-video-player
        onPointerDownCapture={stopInteractiveEvent}
      >
        <VideoPlayer
          src={src}
          poster={cover}
          theme={theme as 'dark' | 'light'}
          loop={loop}
          muted={muted}
          autoPlay={false}
          volume={100}
          clickToPlay
          defaultPlaybackRate={1}
          playbackRateList={[
            { label: '0.5x', value: 0.5 },
            { label: '1.0x', value: 1 },
            { label: '1.5x', value: 1.5 },
            { label: '2.0x', value: 2 },
          ]}
          width="100%"
          height="100%"
          controlsList={['play', 'time', 'volume', 'playbackRate', 'fullscreen']}
        />
      </div>
    );
  }

  return (
    <div
      className={`timenotes-video-player timenotes-video-${theme}`}
      data-video-player
    >
      <VideoPlayer
        ref={videoRef}
        src={src}
        poster={cover}
        theme={theme as 'dark' | 'light'}
        loop={loop}
        muted={muted}
        autoPlay={false}
        volume={100}
        clickToPlay
        defaultPlaybackRate={1}
        playbackRateList={[
          { label: '0.5x', value: 0.5 },
          { label: '1.0x', value: 1 },
          { label: '1.5x', value: 1.5 },
          { label: '2.0x', value: 2 },
        ]}
        width="100%"
        height="100%"
        controlsList={['play', 'time', 'volume', 'playbackRate', 'fullscreen', 'pictureInPicture']}
        style={{ pointerEvents: 'auto' }}
      />
    </div>
  );
}

function videoMode(width: number, height: number) {
  if (width < 180 || height < 120) {
    return 'button';
  }
  if (width < 320 || height < 200) {
    return 'compact';
  }
  return 'full';
}

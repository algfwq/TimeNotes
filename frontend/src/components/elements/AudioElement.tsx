import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconBackward,
  IconFastForward,
  IconMusic,
  IconPause,
  IconPlay,
  IconRefresh,
  IconVolume2,
  IconVolumnSilent,
} from '@douyinfe/semi-icons';
import { Toast } from '@douyinfe/semi-ui';
import type { AssetMeta, NoteElement, ResourceTransferProgress } from '../../types';
import { assetCoverDataUrl, assetDataUrl } from '../../lib/files';

const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function AudioElement({
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Number(asset?.duration ?? 0));
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState('');
  const src = assetDataUrl(asset);
  const cover = assetCoverDataUrl(asset);
  const title = asset?.audioTitle || asset?.name || progress?.name || '音频';
  const subtitle = [asset?.audioArtist, asset?.audioAlbum].filter(Boolean).join(' · ');
  const mode = useMemo(() => audioMode(element.width, element.height), [element.height, element.width]);
  const theme = String(element.style?.audioTheme ?? 'light') === 'dark' ? 'dark' : 'light';
  const loadedProgress = progress?.progress ?? 0;
  const transferPercent = Math.round(loadedProgress * 100);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.volume = volume;
    audio.muted = muted;
    audio.playbackRate = rate;
  }, [muted, rate, volume]);

  useEffect(() => {
    setDuration(Number(asset?.duration ?? 0));
    setCurrentTime(0);
    setPlaying(false);
    setError('');
  }, [asset?.id, asset?.duration]);

  const stopInteractiveEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !src) {
      Toast.warning(progress ? `音频素材正在传输（${transferPercent}%），完成后可播放` : '音频素材尚未传输完成，完成后可播放');
      return;
    }
    try {
      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }
      setError('');
    } catch {
      setPlaying(false);
      setError('无法播放');
    }
  };

  const seekTo = (value: number) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const next = clamp(value, 0, duration || audio.duration || 0);
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const jump = (delta: number) => {
    seekTo(currentTime + delta);
  };

  const restart = () => {
    seekTo(0);
    if (playing) {
      void audioRef.current?.play();
    }
  };

  if (mode === 'button') {
    return (
      <div className={`timenotes-audio-player timenotes-audio-${theme} timenotes-audio-button`} data-audio-player>
        {src ? <audio ref={audioRef} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /> : null}
        <AudioButton label={playing ? '暂停' : '播放'} primary onClick={togglePlay}>
          {playing ? <IconPause /> : <IconPlay />}
        </AudioButton>
      </div>
    );
  }

  if (!src) {
    return (
      <div
        className={`timenotes-audio-player timenotes-audio-${theme} timenotes-audio-${mode} timenotes-audio-missing timenotes-audio-transfer`}
        data-audio-player
        onPointerDownCapture={readOnly ? stopInteractiveEvent : undefined}
        onWheel={stopInteractiveEvent}
      >
        {mode !== 'compact' ? <AudioCover cover={cover} /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <AudioButton label="播放" primary onClick={togglePlay}>
              <IconPlay />
            </AudioButton>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-5">{title}</div>
              {mode === 'full' ? <div className="truncate text-xs opacity-60">{subtitle || asset?.name || progress?.name || '音频素材'}</div> : null}
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] opacity-65">{progress ? '传输中' : '等待同步'}</span>
            <div className="timenotes-audio-transfer-bar min-w-0 flex-1" data-audio-interactive>
              <div style={{ width: `${progress ? transferPercent : 8}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums opacity-65">{progress ? `${transferPercent}%` : '--'}</span>
          </div>
          {mode === 'full' && progress ? (
            <div className="mt-1 truncate text-[11px] opacity-55">
              {formatBytes(progress.receivedBytes)} / {formatBytes(progress.totalBytes)}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`timenotes-audio-player timenotes-audio-${theme} timenotes-audio-${mode}`}
      data-audio-player
      onPointerDownCapture={readOnly ? stopInteractiveEvent : undefined}
      onWheel={stopInteractiveEvent}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(Number(event.currentTarget.duration || asset?.duration || 0))}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setError('无法播放');
        }}
      />
      {mode !== 'compact' ? <AudioCover cover={cover} /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <AudioButton label={playing ? '暂停' : '播放'} primary onClick={togglePlay}>
            {playing ? <IconPause /> : <IconPlay />}
          </AudioButton>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-5">{title}</div>
            {mode === 'full' ? <div className="truncate text-xs opacity-60">{subtitle || asset?.name}</div> : null}
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <span className="w-10 shrink-0 text-[11px] tabular-nums opacity-65">{formatTime(currentTime)}</span>
          <input
            data-audio-interactive
            className="timenotes-audio-range min-w-0 flex-1"
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={0.1}
            value={clamp(currentTime, 0, Math.max(1, duration))}
            onPointerDown={stopInteractiveEvent}
            onMouseDown={stopInteractiveEvent}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums opacity-65">{formatTime(duration)}</span>
        </div>
        {mode === 'full' ? (
          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            <AudioButton label="后退 10 秒" onClick={() => jump(-10)}>
              <IconBackward />
            </AudioButton>
            <AudioButton label="前进 10 秒" onClick={() => jump(10)}>
              <IconFastForward />
            </AudioButton>
            <AudioButton label="重播" onClick={restart}>
              <IconRefresh />
            </AudioButton>
            <AudioButton label={muted ? '取消静音' : '静音'} onClick={() => setMuted((current) => !current)}>
              {muted || volume === 0 ? <IconVolumnSilent /> : <IconVolume2 />}
            </AudioButton>
            <input
              data-audio-interactive
              className="timenotes-audio-range w-20"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onPointerDown={stopInteractiveEvent}
              onMouseDown={stopInteractiveEvent}
              onChange={(event) => {
                const next = Number(event.target.value);
                setVolume(next);
                setMuted(next === 0);
              }}
            />
            <select
              data-audio-interactive
              className="ml-auto h-7 rounded-[6px] border border-current/15 bg-transparent px-1.5 text-xs outline-none"
              value={rate}
              onPointerDown={stopInteractiveEvent}
              onMouseDown={stopInteractiveEvent}
              onChange={(event) => setRate(Number(event.target.value))}
              aria-label="播放速度"
            >
              {speedOptions.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {error ? <div className="mt-1 truncate text-[11px] text-red-500">{error}</div> : null}
      </div>
    </div>
  );
}

function AudioCover({ cover }: { cover?: string }) {
  return (
    <div className="timenotes-audio-cover shrink-0 overflow-hidden">
      {cover ? <img className="h-full w-full object-cover" src={cover} alt="" draggable={false} /> : <IconMusic />}
    </div>
  );
}

function AudioButton({ label, primary, children, onClick }: { label: string; primary?: boolean; children: React.ReactNode; onClick: () => void }) {
  const stop = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };
  return (
    <button
      data-audio-interactive
      type="button"
      aria-label={label}
      title={label}
      className={`timenotes-audio-icon-btn ${primary ? 'timenotes-audio-icon-primary' : ''}`}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function audioMode(width: number, height: number) {
  if (width < 76 || height < 54) {
    return 'button';
  }
  if (width < 260 || height < 78) {
    return 'compact';
  }
  if (width < 380 || height < 118) {
    return 'medium';
  }
  return 'full';
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0:00';
  }
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

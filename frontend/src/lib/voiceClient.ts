export interface VoiceSignal {
  kind: 'offer' | 'answer' | 'ice';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface VoiceState {
  micEnabled: boolean;
  isSpeaking: boolean;
  speakingPeers: string[];
}

export type VoiceStateChangeHandler = (state: VoiceState) => void;

// VoiceClient 管理麦克风采集、语音传输和说话状态检测。
// 主路径：Media Tracks P2P（浏览器原生 Opus，延迟最低）；
// 降级路径：MediaRecorder → DataChannel relay（NAT 穿透失败时）。
// 两条路径互斥：当某个对等方的 Media P2P 连接成功（连上且收到音轨）时，
// 该对等方的 relay 音频会被丢弃，避免同一个人的声音被播放两遍（回声/双声）。
export class VoiceClient {
  private micStream: MediaStream | null = null;
  micEnabled = false;
  isSpeaking = false;
  speakingPeers = new Set<string>();

  // 本机 clientId，用于 perfect negotiation 判定礼让方。
  private readonly selfId: string;

  // Media P2P：每个对等方一条独立的音频 RTCPeerConnection。
  private mediaPCs = new Map<string, RTCPeerConnection>();

  // perfect negotiation：记录每个对等方当前是否正在主动发起 offer。
  private makingOffer = new Set<string>();

  // 已收到远端音轨的对等方（ontrack 已触发）。
  private remoteTrackPeers = new Set<string>();

  // Media P2P 已就绪（连上 + 收到音轨）的对等方：这些对等方走原生音轨播放，
  // relay 音频对它们一律丢弃。
  private mediaActivePeers = new Set<string>();

  // Relay 降级：MediaRecorder 采集 + DataChannel/WS 发送。
  private mediaRecorder: MediaRecorder | null = null;

  // 远端 relay 音频回放缓冲。
  private remoteRelayBuffers = new Map<string, ArrayBuffer[]>();
  // 远端 relay 回放的 <audio> 元素与 objectURL，用于清理。
  private relayPlaybacks = new Map<string, { audio: HTMLAudioElement; url: string }>();

  // 远端说话超时：记录每个 peer 最后一次活跃（收到音频数据或检测到音量）的时间。
  private remoteChunkTimestamps = new Map<string, number>();
  private remoteSpeakingTimer: ReturnType<typeof setInterval> | null = null;
  private static REMOTE_SPEAKING_TIMEOUT_MS = 1500;
  private static REMOTE_CLEANUP_MS = 600;

  // 说话检测：AudioContext + AnalyserNode 实时分析音量。
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private volumePollTimer: ReturnType<typeof setInterval> | null = null;
  private speakingTimer: ReturnType<typeof setTimeout> | null = null;
  private static SPEAKING_TIMEOUT_MS = 1200;
  private static VOLUME_POLL_MS = 80;
  private static SPEAKING_THRESHOLD = 0.02;

  // 远端音轨说话检测：共用一个 AudioContext，每个对等方一个 AnalyserNode。
  private remoteAudioContext: AudioContext | null = null;
  private remoteAnalysers = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode }>();
  private remoteVolumeTimer: ReturnType<typeof setInterval> | null = null;

  // 回调
  private onChange: VoiceStateChangeHandler | null;
  private readonly sendSignal: (peerId: string, signal: VoiceSignal) => void;
  private readonly sendRelayChunk: (chunk: ArrayBuffer) => void;
  private readonly sendVoiceControl: (ctrl: 'stop') => void;
  private readonly iceServers: RTCIceServer[];

  constructor(options: {
    selfId: string;
    sendSignal: (peerId: string, signal: VoiceSignal) => void;
    sendRelayChunk: (chunk: ArrayBuffer) => void;
    sendVoiceControl: (ctrl: 'stop') => void;
    iceServers: RTCIceServer[];
    onChange?: VoiceStateChangeHandler;
  }) {
    this.selfId = options.selfId;
    this.sendSignal = options.sendSignal;
    this.sendRelayChunk = options.sendRelayChunk;
    this.sendVoiceControl = options.sendVoiceControl;
    this.iceServers = options.iceServers;
    this.onChange = options.onChange ?? null;
    // 远端说话超时清理与本机麦克风状态无关：只要在房间内（哪怕只听不说）就需要它。
    this.startRemoteSpeakingCleanup();
  }

  get state(): VoiceState {
    return {
      micEnabled: this.micEnabled,
      isSpeaking: this.isSpeaking,
      speakingPeers: Array.from(this.speakingPeers),
    };
  }

  private emit() {
    this.onChange?.(this.state);
  }

  // 开启麦克风（仅影响「发送」，不影响「接收」）：
  // 1. 请求浏览器麦克风权限
  // 2. 启动 MediaRecorder 采集（为 relay 降级准备）
  // 3. 把本机音轨加入所有已有的 Media P2P 连接（触发重协商）
  async startMic(): Promise<void> {
    if (this.micEnabled || this.micStream) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micStream = stream;
    this.micEnabled = true;

    // 启动 AudioContext + AnalyserNode 做本机音量检测。
    this.startVolumeDetection(stream);

    // 启动 MediaRecorder 作为 relay 降级数据源。
    this.startMediaRecorder();

    // 把本机音轨加入所有已有 Media P2P；onnegotiationneeded 会发起 offer。
    this.mediaPCs.forEach((_, peerId) => {
      this.addLocalTracks(peerId);
    });

    this.emit();
  }

  // 关闭麦克风：只停止「发送」，保留所有「接收」资源，确保静音后仍能听到他人。
  stopMic(): void {
    if (!this.micEnabled && !this.micStream) {
      return;
    }
    this.micEnabled = false;

    // 停止本机音量检测。
    this.stopVolumeDetection();

    // 停止 MediaRecorder。
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    // 从每条 Media P2P 移除本机音轨（保持连接以继续接收他人音频）。
    this.mediaPCs.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'audio') {
          try {
            pc.removeTrack(sender);
          } catch {
            // 移除失败忽略，停轨后远端自然收到静音。
          }
        }
      });
    });

    // 释放麦克风硬件（OS 麦克风占用指示熄灭）。
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    // 重置本机说话状态。
    this.markNotSpeaking();

    // 通知其他对等方本机已关麦。
    this.sendVoiceControl('stop');

    // 注意：不清理 mediaPCs / remoteRelayBuffers / 远端清理定时器，
    // 这些属于「接收」侧资源，静音期间仍要保留以继续听到他人。
    this.emit();
  }

  toggleMic(): Promise<void> {
    return this.micEnabled ? Promise.resolve(this.stopMic()) : this.startMic();
  }

  // 对等方上线：为它创建 Media P2P 连接。
  handlePeerConnected(peerId: string): void {
    if (peerId === this.selfId || this.mediaPCs.has(peerId)) {
      return;
    }
    this.createMediaPC(peerId);
    if (this.micEnabled && this.micStream) {
      this.addLocalTracks(peerId);
    }
  }

  // 对等方离线：关闭它的 Media P2P 连接并清理所有相关播放资源。
  handlePeerDisconnected(peerId: string): void {
    const pc = this.mediaPCs.get(peerId);
    if (pc) {
      pc.close();
      this.mediaPCs.delete(peerId);
    }
    this.makingOffer.delete(peerId);
    this.removeMediaPlayback(peerId);
    this.removeRelayPlayback(peerId);
    this.speakingPeers.delete(peerId);
    this.remoteChunkTimestamps.delete(peerId);
    this.emit();
  }

  // 收到 Media P2P 信令（perfect negotiation）。
  async handleVoiceSignal(from: string, signal: VoiceSignal): Promise<void> {
    if (from === this.selfId) {
      return;
    }
    let pc = this.mediaPCs.get(from);
    if (!pc) {
      pc = this.createMediaPC(from);
      if (this.micEnabled && this.micStream) {
        this.addLocalTracks(from);
      }
    }

    try {
      if (signal.kind === 'offer' && signal.sdp) {
        // 礼让方（selfId 较大）在冲突时回滚自己的本地 offer 接受对方；
        // 非礼让方在冲突时忽略对方 offer，由对方接受我方 offer。
        const polite = this.selfId > from;
        const collision = this.makingOffer.has(from) || pc.signalingState !== 'stable';
        if (!polite && collision) {
          return;
        }
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        await pc.setLocalDescription();
        this.sendSignal(from, { kind: 'answer', sdp: pc.localDescription?.sdp ?? '' });
      } else if (signal.kind === 'answer' && signal.sdp) {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        }
      } else if (signal.kind === 'ice' && signal.candidate) {
        await pc.addIceCandidate(signal.candidate);
      }
    } catch {
      // 协商冲突或候选过期等错误静默忽略；ICE 失败时由 relay 兜底。
    }
  }

  // 收到 relay 语音数据分片（来自 DataChannel 或 WebSocket）。
  handleVoiceChunk(from: string, chunk: ArrayBuffer): void {
    if (from === this.selfId) {
      return;
    }
    // Media P2P 已就绪的对等方走原生音轨，relay 分片直接丢弃，避免双声/回声。
    if (this.mediaActivePeers.has(from)) {
      return;
    }

    // 标记对等方正说话并记录时间戳。
    this.speakingPeers.add(from);
    this.remoteChunkTimestamps.set(from, performance.now());
    this.emit();

    // 将 chunk 添加到对等方的缓冲区。
    let buffer = this.remoteRelayBuffers.get(from);
    if (!buffer) {
      buffer = [];
      this.remoteRelayBuffers.set(from, buffer);
      // 当第一个 chunk 到达时，启动 MediaSource 播放。
      this.startRelayPlayback(from);
    }
    buffer.push(chunk);
  }

  // 收到远端关麦通知：清除该 peer 的说话状态，并拆除 relay 回放以便下次重新初始化。
  handleVoiceControl(from: string, ctrl: 'stop'): void {
    if (ctrl === 'stop') {
      this.speakingPeers.delete(from);
      this.remoteChunkTimestamps.delete(from);
      // relay MediaSource 是连续流，下一次开麦会产生新的 webm 初始化段，
      // 必须先拆除旧的 MediaSource，否则新初始化段被追加到旧流中导致解码失败。
      this.removeRelayPlayback(from);
      this.emit();
    }
  }

  destroy(): void {
    this.stopMic();
    // 拆除所有接收侧资源。
    this.mediaPCs.forEach((pc, peerId) => {
      pc.close();
      this.removeMediaPlayback(peerId);
      this.removeRelayPlayback(peerId);
    });
    this.mediaPCs.clear();
    this.makingOffer.clear();
    this.speakingPeers.clear();
    this.remoteChunkTimestamps.clear();
    if (this.remoteSpeakingTimer) {
      clearInterval(this.remoteSpeakingTimer);
      this.remoteSpeakingTimer = null;
    }
    this.stopRemoteVolumeDetection();
    if (this.remoteAudioContext && this.remoteAudioContext.state !== 'closed') {
      this.remoteAudioContext.close().catch(() => {});
    }
    this.remoteAudioContext = null;
    this.onChange = null;
  }

  // ─── Private helpers ───

  // 创建一条 Media P2P 连接并挂载事件（perfect negotiation）。
  private createMediaPC(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.mediaPCs.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, { kind: 'ice', candidate: event.candidate.toJSON() });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer.add(peerId);
        await pc.setLocalDescription();
        this.sendSignal(peerId, { kind: 'offer', sdp: pc.localDescription?.sdp ?? '' });
      } catch {
        // offer 创建失败静默处理，relay 路径兜底。
      } finally {
        this.makingOffer.delete(peerId);
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) {
        return;
      }
      this.remoteTrackPeers.add(peerId);
      this.playRemoteStream(peerId, stream);
      // 若此时连接已建立，立即切换到原生音轨并停掉 relay 回放。
      if (pc.connectionState === 'connected') {
        this.activateMediaPeer(peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (this.remoteTrackPeers.has(peerId)) {
          this.activateMediaPeer(peerId);
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        // Media P2P 不可用：回退到 relay 路径，清理原生音轨播放。
        this.mediaActivePeers.delete(peerId);
        this.remoteTrackPeers.delete(peerId);
        this.removeMediaPlayback(peerId);
        if (pc.connectionState !== 'disconnected') {
          this.mediaPCs.delete(peerId);
        }
        this.speakingPeers.delete(peerId);
        this.emit();
      }
    };

    return pc;
  }

  // Media P2P 就绪：标记为原生音轨路径并拆除可能正在播放的 relay 回放。
  private activateMediaPeer(peerId: string): void {
    if (this.mediaActivePeers.has(peerId)) {
      return;
    }
    this.mediaActivePeers.add(peerId);
    this.removeRelayPlayback(peerId);
  }

  // 把本机音轨加入指定 Media P2P；addTrack 会触发 onnegotiationneeded 发起协商。
  private addLocalTracks(peerId: string): void {
    const pc = this.mediaPCs.get(peerId);
    if (!pc || !this.micStream) {
      return;
    }
    this.micStream.getAudioTracks().forEach((track) => {
      const already = pc.getSenders().some((sender) => sender.track === track);
      if (already) {
        return;
      }
      // 复用此前 removeTrack 留下的空 sender（避免新增 m-line）。
      const reusable = pc.getSenders().find((sender) => sender.track === null);
      if (reusable) {
        void reusable.replaceTrack(track);
      } else {
        pc.addTrack(track, this.micStream!);
      }
    });
  }

  // 定期检查远端 peer 的最后活跃时间，超时则清除说话状态。
  private startRemoteSpeakingCleanup(): void {
    if (this.remoteSpeakingTimer) {
      return;
    }
    this.remoteSpeakingTimer = setInterval(() => {
      const now = performance.now();
      let changed = false;
      this.remoteChunkTimestamps.forEach((lastTime, peerId) => {
        if (now - lastTime > VoiceClient.REMOTE_SPEAKING_TIMEOUT_MS) {
          this.speakingPeers.delete(peerId);
          this.remoteChunkTimestamps.delete(peerId);
          changed = true;
        }
      });
      if (changed) {
        this.emit();
      }
    }, VoiceClient.REMOTE_CLEANUP_MS);
  }

  private startMediaRecorder(): void {
    if (!this.micStream || this.mediaRecorder) {
      return;
    }
    try {
      // MediaRecorder 使用短分片间隔确保低延迟。
      const recorder = new MediaRecorder(this.micStream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined,
      });
      this.mediaRecorder = recorder;

      recorder.ondataavailable = (event) => {
        if (!this.micEnabled || !event.data || event.data.size === 0) {
          return;
        }
        // 读取分片并发送（音量检测独立于数据流，由 AnalyserNode 轮询负责）。
        event.data.arrayBuffer().then((buffer) => {
          if (this.micEnabled) {
            this.sendRelayChunk(buffer);
          }
        }).catch(() => {
          // 读取失败静默丢弃。
        });
      };

      // 200ms 分片间隔：平衡延迟和分片数量。
      recorder.start(200);
    } catch {
      // 浏览器不支持 MediaRecorder：仅 P2P 路径可用。
    }
  }

  // 本机音量检测：通过 AnalyserNode 读取实时音量，超过阈值即标记「正在说话」。
  private startVolumeDetection(stream: MediaStream): void {
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.4;
      source.connect(this.analyserNode);

      const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
      this.volumePollTimer = setInterval(() => {
        if (!this.analyserNode || !this.micEnabled) {
          return;
        }
        this.analyserNode.getByteTimeDomainData(dataArray);
        if (this.computeRms(dataArray) > VoiceClient.SPEAKING_THRESHOLD) {
          this.isSpeaking = true;
          this.emit();
          this.resetSpeakingTimer();
        }
      }, VoiceClient.VOLUME_POLL_MS);
    } catch {
      // AudioContext 不可用时静默降级（不影响语音传输本身）。
    }
  }

  private stopVolumeDetection(): void {
    if (this.volumePollTimer) {
      clearInterval(this.volumePollTimer);
      this.volumePollTimer = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.analyserNode = null;
    this.markNotSpeaking();
  }

  private computeRms(dataArray: Uint8Array): number {
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / dataArray.length);
  }

  private playRemoteStream(peerId: string, stream: MediaStream): void {
    // 为远端音频流创建（或复用）<audio> 元素。
    let audio = document.getElementById(`voice-audio-${peerId}`) as HTMLAudioElement | null;
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `voice-audio-${peerId}`;
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;

    // 通过 AnalyserNode 检测远端音量驱动「正在说话」状态（不接到 destination，避免重复播放）。
    this.attachRemoteAnalyser(peerId, stream);
  }

  private attachRemoteAnalyser(peerId: string, stream: MediaStream): void {
    try {
      if (!this.remoteAudioContext) {
        this.remoteAudioContext = new AudioContext();
      }
      const existing = this.remoteAnalysers.get(peerId);
      if (existing) {
        try {
          existing.source.disconnect();
        } catch {
          // ignore
        }
        this.remoteAnalysers.delete(peerId);
      }
      const source = this.remoteAudioContext.createMediaStreamSource(stream);
      const analyser = this.remoteAudioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      this.remoteAnalysers.set(peerId, { source, analyser });
      this.startRemoteVolumeDetection();
    } catch {
      // 远端音量分析不可用时静默降级（不影响音频播放本身）。
    }
  }

  private startRemoteVolumeDetection(): void {
    if (this.remoteVolumeTimer) {
      return;
    }
    this.remoteVolumeTimer = setInterval(() => {
      if (this.remoteAnalysers.size === 0) {
        return;
      }
      let changed = false;
      const now = performance.now();
      this.remoteAnalysers.forEach(({ analyser }, peerId) => {
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(dataArray);
        if (this.computeRms(dataArray) > VoiceClient.SPEAKING_THRESHOLD) {
          if (!this.speakingPeers.has(peerId)) {
            this.speakingPeers.add(peerId);
            changed = true;
          }
          // 复用 relay 路径的超时清理机制。
          this.remoteChunkTimestamps.set(peerId, now);
        }
      });
      if (changed) {
        this.emit();
      }
    }, VoiceClient.VOLUME_POLL_MS);
  }

  private stopRemoteVolumeDetection(): void {
    if (this.remoteVolumeTimer) {
      clearInterval(this.remoteVolumeTimer);
      this.remoteVolumeTimer = null;
    }
    this.remoteAnalysers.forEach(({ source }) => {
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    });
    this.remoteAnalysers.clear();
  }

  // 移除原生音轨播放资源（<audio> 元素 + 远端音量分析）。
  private removeMediaPlayback(peerId: string): void {
    const el = document.getElementById(`voice-audio-${peerId}`);
    if (el) {
      el.remove();
    }
    const analyser = this.remoteAnalysers.get(peerId);
    if (analyser) {
      try {
        analyser.source.disconnect();
      } catch {
        // ignore
      }
      this.remoteAnalysers.delete(peerId);
    }
    if (this.remoteAnalysers.size === 0) {
      this.stopRemoteVolumeDetection();
    }
  }

  private startRelayPlayback(peerId: string): void {
    // 已有原生音轨的对等方不走 relay 回放。
    if (this.mediaActivePeers.has(peerId)) {
      return;
    }
    // 使用 MediaSource API 连续播放 relay 语音流。
    const mimeType = 'audio/webm;codecs=opus';
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) {
      return;
    }
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    const audio = document.createElement('audio');
    audio.id = `voice-relay-${peerId}`;
    audio.src = url;
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    this.relayPlaybacks.set(peerId, { audio, url });

    let sourceBuffer: SourceBuffer | null = null;
    mediaSource.addEventListener('sourceopen', () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', () => {
          this.flushRelayBuffer(peerId, sourceBuffer!);
        });
        this.flushRelayBuffer(peerId, sourceBuffer);
      } catch {
        // 编码不支持时静默降级。
      }
    });
  }

  private flushRelayBuffer(peerId: string, sourceBuffer: SourceBuffer): void {
    if (sourceBuffer.updating) {
      return;
    }
    const buffer = this.remoteRelayBuffers.get(peerId);
    if (!buffer || buffer.length === 0) {
      return;
    }
    try {
      const chunk = buffer.shift()!;
      sourceBuffer.appendBuffer(new Uint8Array(chunk));
    } catch {
      // 追加失败时清除这个分片。
    }
    // 限制缓冲区大小（最多保留 30 个分片 ≈ 6 秒）。
    while (buffer.length > 30) {
      buffer.shift();
    }
  }

  // 拆除 relay 回放资源（<audio> 元素、objectURL、缓冲区）。
  private removeRelayPlayback(peerId: string): void {
    const playback = this.relayPlaybacks.get(peerId);
    if (playback) {
      try {
        playback.audio.pause();
        playback.audio.removeAttribute('src');
        playback.audio.load();
      } catch {
        // ignore
      }
      playback.audio.remove();
      URL.revokeObjectURL(playback.url);
      this.relayPlaybacks.delete(peerId);
    }
    this.remoteRelayBuffers.delete(peerId);
  }

  private resetSpeakingTimer(): void {
    if (this.speakingTimer) {
      clearTimeout(this.speakingTimer);
    }
    this.speakingTimer = setTimeout(() => {
      this.markNotSpeaking();
    }, VoiceClient.SPEAKING_TIMEOUT_MS);
  }

  private markNotSpeaking(): void {
    if (!this.isSpeaking) {
      return;
    }
    this.isSpeaking = false;
    this.emit();
  }
}

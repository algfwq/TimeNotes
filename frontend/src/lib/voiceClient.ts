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
export class VoiceClient {
  private micStream: MediaStream | null = null;
  micEnabled = false;
  isSpeaking = false;
  speakingPeers = new Set<string>();

  // Media P2P：每个对等方一条独立的音频 RTCPeerConnection。
  private mediaPCs = new Map<string, RTCPeerConnection>();

  // Relay 降级：MediaRecorder 采集 + DataChannel/WS 发送。
  private mediaRecorder: MediaRecorder | null = null;

  // 远端 relay 音频回放缓冲。
  private remoteRelayBuffers = new Map<string, ArrayBuffer[]>();

  // 远端说话超时：记录每个 peer 最后一次收到音频数据的时间。
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

  // 回调
  private onChange: VoiceStateChangeHandler | null;
  private readonly sendSignal: (peerId: string, signal: VoiceSignal) => void;
  private readonly sendRelayChunk: (chunk: ArrayBuffer) => void;
  private readonly sendVoiceControl: (ctrl: 'stop') => void;
  private readonly iceServers: RTCIceServer[];

  constructor(options: {
    sendSignal: (peerId: string, signal: VoiceSignal) => void;
    sendRelayChunk: (chunk: ArrayBuffer) => void;
    sendVoiceControl: (ctrl: 'stop') => void;
    iceServers: RTCIceServer[];
    onChange?: VoiceStateChangeHandler;
  }) {
    this.sendSignal = options.sendSignal;
    this.sendRelayChunk = options.sendRelayChunk;
    this.sendVoiceControl = options.sendVoiceControl;
    this.iceServers = options.iceServers;
    this.onChange = options.onChange ?? null;
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

  // 开启麦克风：
  // 1. 请求浏览器麦克风权限
  // 2. 启动 MediaRecorder 采集（为 relay 降级准备）
  // 3. 为已有对等方创建 Media P2P 连接
  async startMic(): Promise<void> {
    if (this.micEnabled || this.micStream) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micStream = stream;
    this.micEnabled = true;

    // 启动 AudioContext + AnalyserNode 做音量检测。
    this.startVolumeDetection(stream);

    // 启动远端说话超时清理定时器。
    this.startRemoteSpeakingCleanup();

    // 启动 MediaRecorder 作为 relay 降级数据源。
    this.startMediaRecorder();

    // 为已有对等方建立 Media P2P。
    this.mediaPCs.forEach((_, peerId) => {
      this.establishMediaP2P(peerId);
    });

    this.emit();
  }

  // 关闭麦克风：释放所有采集和发送资源。
  stopMic(): void {
    this.micEnabled = false;

    // 停止音量检测。
    this.stopVolumeDetection();

    // 停止 MediaRecorder。
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    // 停止 mic 轨道。
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    // 关闭所有 Media P2P 连接。
    this.mediaPCs.forEach((pc) => pc.close());
    this.mediaPCs.clear();

    // 重置说话状态。
    this.markNotSpeaking();
    this.speakingPeers.clear();
    this.remoteChunkTimestamps.clear();

    // 通知其他对等方本机已关麦。
    this.sendVoiceControl('stop');

    // 清理远端 relay buffer 和定时器。
    this.remoteRelayBuffers.clear();
    if (this.remoteSpeakingTimer) {
      clearInterval(this.remoteSpeakingTimer);
      this.remoteSpeakingTimer = null;
    }

    this.emit();
  }

  toggleMic(): Promise<void> {
    return this.micEnabled ? Promise.resolve(this.stopMic()) : this.startMic();
  }

  // 对等方上线：为它创建 Media P2P 连接。
  handlePeerConnected(peerId: string): void {
    if (this.mediaPCs.has(peerId)) {
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.mediaPCs.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, { kind: 'ice', candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      // 远端音频流到达：创建 <audio> 元素播放。
      const stream = event.streams[0];
      if (!stream) {
        return;
      }
      this.playRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        this.mediaPCs.delete(peerId);
        this.speakingPeers.delete(peerId);
        this.emit();
      }
    };

    if (this.micEnabled && this.micStream) {
      this.establishMediaP2P(peerId);
    }
  }

  // 对等方离线：关闭它的 Media P2P 连接。
  handlePeerDisconnected(peerId: string): void {
    const pc = this.mediaPCs.get(peerId);
    if (pc) {
      pc.close();
      this.mediaPCs.delete(peerId);
    }
    this.speakingPeers.delete(peerId);
    this.remoteRelayBuffers.delete(peerId);
    this.emit();
  }

  // 收到 Media P2P 信令。
  async handleVoiceSignal(from: string, signal: VoiceSignal): Promise<void> {
    let pc = this.mediaPCs.get(from);
    if (!pc) {
      pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.mediaPCs.set(from, pc);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignal(from, { kind: 'ice', candidate: event.candidate.toJSON() });
        }
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) {
          this.playRemoteStream(from, stream);
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc!.connectionState === 'failed' || pc!.connectionState === 'disconnected' || pc!.connectionState === 'closed') {
          this.mediaPCs.delete(from);
          this.speakingPeers.delete(from);
          this.emit();
        }
      };

      if (this.micEnabled && this.micStream) {
        this.micStream.getTracks().forEach((track) => {
          pc!.addTrack(track, this.micStream!);
        });
      }
    }

    if (signal.kind === 'offer' && signal.sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignal(from, { kind: 'answer', sdp: answer.sdp ?? '' });
    } else if (signal.kind === 'answer' && signal.sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.kind === 'ice' && signal.candidate) {
      await pc.addIceCandidate(signal.candidate);
    }
  }

  // 收到 relay 语音数据分片（来自 DataChannel 或 WebSocket）。
  handleVoiceChunk(from: string, chunk: ArrayBuffer): void {
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

  // 音量检测：通过 AnalyserNode 读取实时音量，超过阈值即标记「正在说话」。
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
        // 计算 RMS 音量。
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        if (rms > VoiceClient.SPEAKING_THRESHOLD) {
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

  // 收到远端关麦通知：立即清除该 peer 的说话状态。
  handleVoiceControl(from: string, ctrl: 'stop'): void {
    if (ctrl === 'stop') {
      this.speakingPeers.delete(from);
      this.remoteChunkTimestamps.delete(from);
      this.emit();
    }
  }

  destroy(): void {
    this.stopMic();
    this.onChange = null;
  }

  // ─── Private helpers ───

  // 定期检查远端 peer 的最后音频到达时间，超时则清除说话状态。
  private startRemoteSpeakingCleanup(): void {
    if (this.remoteSpeakingTimer) {
      clearInterval(this.remoteSpeakingTimer);
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

  private establishMediaP2P(peerId: string): void {
    const pc = this.mediaPCs.get(peerId);
    if (!pc || !this.micStream) {
      return;
    }
    // 将麦克风轨道加入媒体连接。
    this.micStream.getTracks().forEach((track) => {
      // 避免重复添加同一个轨道。
      const senders = pc.getSenders();
      if (!senders.some((s) => s.track === track)) {
        pc.addTrack(track, this.micStream!);
      }
    });

    // 发起 offer。
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        if (pc.localDescription) {
          this.sendSignal(peerId, { kind: 'offer', sdp: pc.localDescription.sdp ?? '' });
        }
      })
      .catch(() => {
        // offer 创建失败静默处理，relay 路径兜底。
      });
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

  private playRemoteStream(peerId: string, stream: MediaStream): void {
    // 为远端音频流创建 <audio> 元素。
    const existing = document.getElementById(`voice-audio-${peerId}`);
    if (existing) {
      existing.remove();
    }
    const audio = document.createElement('audio');
    audio.id = `voice-audio-${peerId}`;
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);

    // 标记对等方为正在说话（Media Tracks 路径基于连接状态）。
    this.speakingPeers.add(peerId);
    this.emit();
  }

  private startRelayPlayback(peerId: string): void {
    // 使用 MediaSource API 连续播放 relay 语音流。
    const mimeType = 'audio/webm;codecs=opus';
    if (!MediaSource.isTypeSupported(mimeType)) {
      return;
    }
    const mediaSource = new MediaSource();
    const audio = document.createElement('audio');
    audio.id = `voice-relay-${peerId}`;
    audio.src = URL.createObjectURL(mediaSource);
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);

    let sourceBuffer: SourceBuffer | null = null;
    mediaSource.addEventListener('sourceopen', () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', () => {
          // 从缓冲区消费已排队的数据。
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

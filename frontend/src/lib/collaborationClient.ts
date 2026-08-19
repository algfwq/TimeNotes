import * as Y from 'yjs';
import { base64ByteLength, base64ToBytes, bytesToBase64 } from './base64';
import {
  announceCompletedResourceTransfer,
  announceResourceTransferInvalidated,
  announceResourceTransferProgress,
  announceResourceTransportReady,
  subscribeOutboundResourceTransfer,
  subscribeResourceTransferInvalidated,
  type OutboundResourceTransfer,
  type ResourceTransferInvalidation,
} from './resourceTransferBus';
import { logFrontend } from './logger';
import type { AssetMeta, ChatMessage, PresenceUser, ResourceGroup } from '../types';
import { VoiceClient, type VoiceSignal, type VoiceState } from './voiceClient';

type Transport = NonNullable<PresenceUser['transport']>;

interface Envelope<T = unknown> {
  v: number;
  type: string;
  id?: string;
  from?: string;
  to?: string;
  sentAt?: string;
  payload?: T;
}

interface AuthOKPayload {
  clientId: string;
  peers?: PresenceUser[];
  compactStateBase64?: string;
  updates?: Array<{ seq: number; updateBase64: string }>;
  isHost?: boolean;
  hostId?: string;
}

export interface CreateRoomResult {
  roomId: string;
  roomKey: string;
  wsUrl: string;
  inviteUrl: string;
  iceServers?: RTCIceServer[];
}

export interface InviteInfo {
  serverUrl: string;
  wsUrl: string;
  iceServers: RTCIceServer[];
  roomId: string;
  roomKey: string;
}

interface DocUpdatePayload {
  updateId: string;
  updateBase64: string;
  relay?: boolean;
}

interface SignalPayload {
  kind: 'offer' | 'answer' | 'ice';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

interface PingPayload {
  pingId: string;
}

interface PongPayload {
  pingId: string;
}

interface FileResourceStartPayload {
  transferId: string;
  key: string;
  group: ResourceGroup;
  asset: AssetMeta;
  signature: string;
  transferVersion?: string;
  totalBytes: number;
  totalChunks: number;
  chunkSize: number;
  relay?: boolean;
}

interface FileResourceChunkPayload {
  transferId: string;
  key: string;
  index: number;
  chunkBase64: string;
  chunkBytes?: number;
  relay?: boolean;
}

interface FileResourceCompletePayload {
  transferId: string;
  key: string;
  relay?: boolean;
}

interface VoiceDataPayload {
  chunkBase64?: string;
  seq?: number;
}

interface JoinRequestPayload {
  requestId: string;
  user: PresenceUser;
}

interface CollaborationClientOptions {
  url: string;
  roomId: string;
  roomKey: string;
  user: PresenceUser;
  yDoc: Y.Doc;
  forceRelay: boolean;
  iceServers?: RTCIceServer[];
  onStatus: (status: string) => void;
  onPeers: (peers: PresenceUser[]) => void;
  onChat: (message: ChatMessage) => void;
  onLatency: (latencyMs?: number) => void;
  onSelf: (user: PresenceUser) => void;
  onJoinPending: () => void;
  onJoinRequest: (request: JoinRequestPayload, respond: (approved: boolean, reason?: string) => void) => void;
  onJoinRejected: (reason: string) => void;
  onJoined: (user: PresenceUser) => void;
  onPeerJoined: (user: PresenceUser) => void;
  onPeerLeft: (user: PresenceUser) => void;
  onKicked: (reason: string) => void;
  onRoomClosed: (message: string) => void;
  onError: (message: string) => void;
  onVoiceState?: (state: VoiceState) => void;
}

interface PeerConnection {
  id: string;
  user: PresenceUser;
  pc: RTCPeerConnection;
  channels: Partial<Record<DataChannelName, RTCDataChannel>>;
  timer: number;
}

interface IncomingFileTransfer {
  peerId: string;
  start: FileResourceStartPayload;
  chunks: Array<string | Uint8Array | undefined>;
  receivedBytes: number;
  receivedChunks: number;
  // 最近一次收到分片的时间；超时会话由定时清扫回收，防止对端中途消失后占住并发名额。
  lastActivityAt: number;
}

const remoteOrigin = 'timenotes-collaboration-remote';
const resourceChunkOrigin = 'timenotes-resource-chunk';
const dataChannelNames = ['doc', 'presence', 'chat', 'file', 'voice'] as const;
type DataChannelName = (typeof dataChannelNames)[number];
type RealtimeChannelName = Exclude<DataChannelName, 'file'>;
const collaborationDocumentKeyPrefix = 'document:';
const docUpdateFlushMs = 90;
const resourceUpdateFlushMs = 45;
const resourceArchiveFlushMs = 180;
const resourceArchiveIdleMs = 1200;
const resourceTransferIdleMs = 1500;
const fileChannelBackpressureRetryMs = 80;
// 有 peer 时先给 WebRTC file 通道一个短窗口，避免 auth_ok 后立刻公告资源必然落到 relay。
const p2pFileReadyWaitMs = 3000;
const p2pFileReadyPollMs = 50;
const fileTransferChunkBytes = 64 * 1024;
const fileTransferChunkBase64Chars = Math.floor(fileTransferChunkBytes / 3) * 4;
// P2P 不做固定限速：吞吐由 DataChannel bufferedAmount 高水位（背压）决定，
// 拥塞时以 8ms 粒度重试；relay 由 WebSocket bufferedAmount 高水位决定。
const fileChannelCongestionRetryMs = 8;
// 传入会话空闲超过该时长视为对端已消失，回收并发名额。
const incomingFileSessionTimeoutMs = 60_000;
const incomingFileSweepIntervalMs = 15_000;
// 校验失败素材的重传冷却：防止"失败→自动重发→再失败"的带宽空转循环。
const rejectedTransferCooldownMs = 5 * 60_000;
const cursorPresenceFlushMs = 120;
const serverPresenceMinIntervalMs = 1000;
const latencyProbeIntervalMs = 3000;
const maxAutomaticSnapshotBytes = 2 * 1024 * 1024;
const maxDataChannelBufferedBytes = 8 * 1024 * 1024;
const maxFileChannelBufferedBytes = 4 * 1024 * 1024;
const maxRelaySocketBufferedBytes = 4 * 1024 * 1024;
const relaySocketBackpressureRetryMs = 10;

// 服务器专属控制消息类型：auth_ok/join 流程/踢人/房间关闭等只能来自服务器 WebSocket。
// P2P DataChannel 上的同名消息一律丢弃，防止恶意协作者伪造 auth_ok 篡改角色或清空文档。
const SERVER_ONLY_TYPES = new Set([
  'auth_ok',
  'join_pending',
  'join_request',
  'join_decision',
  'join_rejected',
  'peer_joined',
  'peer_left',
  'peer_kicked',
  'host_changed',
  'room_closed',
  'compaction_request',
  'doc_update_rejected',
  'error',
]);

// 网络帧解析防护：服务器或对端发来的畸形 JSON 不应让 message 事件回调抛未捕获异常。
function parseEnvelopeSafe(data: unknown): Envelope | undefined {
  try {
    const parsed = JSON.parse(typeof data === 'string' ? data : String(data)) as Envelope;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// 去重集合上限：超限后整体重置，防止长会话内存无限增长。
const seenIdSetLimit = 4096;

function rememberSeenId(set: Set<string>, id: string) {
  if (set.size >= seenIdSetLimit) {
    set.clear();
  }
  set.add(id);
}

// CollaborationClient 是前端协作的网络内核：
// - WebSocket 负责鉴权、房间成员、信令、持久化和应用层中转；
// - WebRTC DataChannel 负责成功打洞后的 P2P 文档、在线状态和聊天传输；
// - Yjs update 是唯一同步单元，收到远端 update 后直接应用到当前 Y.Doc。
export class CollaborationClient {
  private options: CollaborationClientOptions;
  private socket?: WebSocket;
  // peers 只保存已经尝试建立 WebRTC 的连接；peerUsers 保存在线成员列表和最新 presence。
  private peers = new Map<string, PeerConnection>();
  private peerUsers = new Map<string, PresenceUser>();
  // 同一个 update/chat 会同时可能从 P2P 和服务端中转到达，必须按 id 去重。
  // 长会话下去重集会无限增长，超过上限后整组重置（老 id 已无重复到达可能）。
  private seenUpdates = new Set<string>();
  private seenChats = new Set<string>();
  // 同一浏览器用户断线重连时 user.id 可能复用，connectionId 用于隔离每次连接生命周期。
  private readonly connectionId = makeId('conn');
  private updateSeq = 0;
  private snapshotCounter = 0;
  private connected = false;
  private presenceTimer?: number;
  private pendingPresenceTimer?: number;
  private latencyTimer?: number;
  private incomingFileSweepTimer?: number;
  private pendingDocTimer?: number;
  private pendingResourceTimer?: number;
  private pendingResourceArchiveTimer?: number;
  private resourceTransportReadyTimer?: number;
  private resourceTransportWaitStartedAt = 0;
  // 本地 Yjs 高频编辑先合并到短队列里，再统一广播，避免拖动元素时刷爆网络。
  private pendingDocUpdates: Uint8Array[] = [];
  private pendingResourceUpdates: Uint8Array[] = [];
  private pendingResourceArchiveEnvelopes: Array<Envelope<DocUpdatePayload>> = [];
  private pendingFileTransfers: OutboundResourceTransfer[] = [];
  private pendingFileTransferKeys = new Set<string>();
  private activeFileTransferKeys = new Set<string>();
  private availableFileTransferKeys = new Set<string>();
  private incomingFileTransfers = new Map<string, IncomingFileTransfer>();
  private pendingPings = new Map<string, number>();
  // 初次拉取服务端历史状态后，下一次本地 update 需要补发“服务端缺失的差量”。
  private nextLocalUpdateStateVector?: Uint8Array;
  private lastDocInteractionAt = 0;
  private lastPresenceSentAt = 0;
  private lastServerPresenceAt = 0;
  private p2pFileTransferActiveUntil = 0;
  private sendingFileTransfer = false;
  private closing = false;
  private voiceClient: VoiceClient | null = null;
  private readonly onYUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly unsubscribeOutboundResourceTransfer: () => void;
  private readonly unsubscribeResourceTransferInvalidated: () => void;

  constructor(options: CollaborationClientOptions) {
    this.options = options;
    this.onYUpdate = (update, origin) => {
      if (origin === remoteOrigin || !this.connected) {
        return;
      }
      if (origin === resourceChunkOrigin) {
        this.queueResourceUpdate(update);
        return;
      }
      this.queueDocUpdate(update);
    };
    this.options.yDoc.on('update', this.onYUpdate);
    this.unsubscribeOutboundResourceTransfer = subscribeOutboundResourceTransfer((transfer) => this.queueFileTransfer(transfer));
    this.unsubscribeResourceTransferInvalidated = subscribeResourceTransferInvalidated((invalidation) => this.invalidateFileTransferAvailability(invalidation));
    this.openSocket();
  }

  disconnect() {
    this.closing = true;
    this.connected = false;
    this.options.yDoc.off('update', this.onYUpdate);
    this.unsubscribeOutboundResourceTransfer();
    this.unsubscribeResourceTransferInvalidated();
    this.clearTimers();
    this.pendingDocUpdates = [];
    this.pendingResourceUpdates = [];
    this.pendingResourceArchiveEnvelopes = [];
    this.pendingFileTransfers = [];
    this.pendingFileTransferKeys.clear();
    this.activeFileTransferKeys.clear();
    this.availableFileTransferKeys.clear();
    this.incomingFileTransfers.clear();
    this.pendingPings.clear();
    this.peers.forEach((peer) => {
      window.clearTimeout(peer.timer);
      peer.pc.close();
    });
    this.peers.clear();
    this.peerUsers.clear();
    this.voiceClient?.destroy();
    this.voiceClient = null;
    this.socket?.close();
    this.socket = undefined;
    this.options.onPeers([]);
    this.options.onStatus('离线');
    this.options.onLatency(undefined);
  }

  setForceRelay(forceRelay: boolean) {
    this.options.forceRelay = forceRelay;
    if (forceRelay) {
      // 强制中转后不再等待 P2P file，立刻放开资源公告/发送。
      this.flushResourceTransportReady();
    }
    this.publishPresence();
  }

  updateUser(patch: Partial<PresenceUser>) {
    this.options.user = { ...this.options.user, ...patch, lastSeen: new Date().toISOString() };
    this.publishPresence();
  }

  updateCursor(cursor?: PresenceUser['cursor']) {
    const nextCursor = cursor ?? null;
    this.options.user = { ...this.options.user, cursor: nextCursor, lastSeen: new Date().toISOString() };
    this.schedulePresence(nextCursor ? cursorPresenceFlushMs : 0);
  }

  sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !this.connected) {
      return;
    }
    const message: ChatMessage = {
      id: makeId('chat'),
      text: trimmed,
      user: this.options.user,
      sentAt: new Date().toISOString(),
      local: true,
    };
    rememberSeenId(this.seenChats, message.id);
    this.options.onChat(message);
    const payload = { messageId: message.id, text: trimmed, user: this.options.user, relay: this.needsRelay('chat') || this.isP2PFileTransferActive() };
    const env = this.makeEnvelope('chat', payload);
    if (!this.isP2PFileTransferActive()) {
      this.sendToPeers('chat', env);
    }
    this.sendSocket(env);
  }

  kickPeer(clientId: string, reason = '房主已将你移出协作房间') {
    if (!clientId || !this.connected) {
      return;
    }
    this.sendSocket(this.makeEnvelope('peer_kick', { clientId, reason }));
  }

  async startMic(): Promise<void> {
    await this.voiceClient?.startMic();
  }

  stopMic(): void {
    this.voiceClient?.stopMic();
  }

  async toggleMic(): Promise<void> {
    await this.voiceClient?.toggleMic();
  }

  getVoiceState(): VoiceState | null {
    return this.voiceClient?.state ?? null;
  }

  // WebSocket 是协作房间的控制面：首帧 auth 通过房间密钥鉴权，后续承载信令和中转包。
  private openSocket() {
    this.options.onStatus('连接中');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      // Android/iOS：页面若是 https://wails.localhost，浏览器会拒绝 ws:// 混合内容。
      const reason = error instanceof Error ? error.message : String(error);
      const mixed =
        /insecure WebSocket|mixed content|HTTPS/i.test(reason) ||
        (typeof window !== 'undefined' &&
          window.location.protocol === 'https:' &&
          /^ws:/i.test(this.options.url));
      this.options.onStatus('连接失败');
      this.options.onError(
        mixed
          ? [
              '当前页面是 HTTPS 安全上下文，无法直接连接 ws:// 协作服务（混合内容被拦截）。',
              `目标：${this.options.url}`,
              'Android 需允许 WebView 混合内容（MIXED_CONTENT_ALWAYS_ALLOW）并重新安装 App；或改用 wss:// 协作服务器。',
              `底层错误：${reason}`,
            ].join('\n')
          : `协作 WebSocket 创建失败：${reason}`,
      );
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.sendSocket(
        this.makeEnvelope('auth', {
          roomId: this.options.roomId,
          roomKey: this.options.roomKey,
          user: this.options.user,
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const env = parseEnvelopeSafe(event.data);
      if (env) {
        this.handleEnvelope(env, 'relay');
      }
    });
    socket.addEventListener('close', () => {
      if (this.closing) {
        return;
      }
      this.connected = false;
      this.clearTimers();
      this.pendingPings.clear();
      this.options.onStatus('已断开');
      this.options.onLatency(undefined);
    });
    socket.addEventListener('error', () => this.options.onError('协作服务连接失败'));
  }

  // 所有网络消息统一解析成 Envelope，再按 type 分发，方便 P2P 与 relay 复用同一套处理逻辑。
  private handleEnvelope(env: Envelope, source: Transport) {
    if (!env || env.v !== 1) {
      return;
    }
    if (source === 'p2p' && SERVER_ONLY_TYPES.has(env.type)) {
      return;
    }
    switch (env.type) {
      case 'auth_ok':
        this.handleAuthOK(env.payload as AuthOKPayload);
        break;
      case 'join_pending':
        this.options.onStatus('等待房主同意');
        this.options.onJoinPending();
        break;
      case 'join_request':
        this.handleJoinRequest(env.payload as JoinRequestPayload);
        break;
      case 'join_rejected': {
        const reason = (env.payload as { reason?: string })?.reason ?? '房主已拒绝加入协作';
        this.options.onJoinRejected(reason);
        break;
      }
      case 'peer_joined':
        this.upsertPeer(env.payload as PresenceUser, true);
        break;
      case 'peer_left':
        this.removePeer((env.payload as { clientId?: string })?.clientId ?? env.from ?? '');
        break;
      case 'peer_kicked':
        this.options.onKicked((env.payload as { reason?: string })?.reason ?? '房主已将你移出协作房间');
        break;
      case 'room_closed':
        this.options.onRoomClosed((env.payload as { reason?: string })?.reason === 'host_left' ? '房主已退出协作，房间已关闭' : '协作房间已关闭');
        break;
      case 'doc_update':
        this.applyDocUpdate(env.payload as DocUpdatePayload);
        break;
      case 'file_resource_start':
        this.applyFileResourceStart(env.from ?? 'relay', env.payload as FileResourceStartPayload);
        break;
      case 'file_resource_chunk':
        this.applyFileResourceChunk(env.from ?? 'relay', env.payload as FileResourceChunkPayload);
        break;
      case 'file_resource_complete':
        void this.applyFileResourceComplete(env.from ?? 'relay', env.payload as FileResourceCompletePayload);
        break;
      case 'presence':
        this.applyPresence((env.payload as { user?: PresenceUser })?.user, source);
        break;
      case 'signal':
        void this.handleSignal(env.from ?? '', env.payload as SignalPayload);
        break;
      case 'chat':
        this.applyChat(env);
        break;
      case 'pong':
        this.applyPong(env.payload as PongPayload);
        break;
      case 'voice_signal':
        if (env.from) {
          void this.voiceClient?.handleVoiceSignal(env.from, env.payload as VoiceSignal);
        }
        break;
      case 'voice_data':
        this.handleVoiceDataRelay(env);
        break;
      case 'voice_ctrl':
        if (env.from) {
          this.voiceClient?.handleVoiceControl(env.from, (env.payload as { ctrl?: string })?.ctrl as 'stop');
        }
        break;
      case 'relay':
        // relay 包装只应来自服务器 WebSocket（sendRelayEnvelope 仅走 sendSocket）；
        // P2P 通道上的 relay 消息若在这里解包会以 relay 来源处理，绕过上面的服务器专属类型过滤。
        if (source === 'p2p') {
          break;
        }
        this.handleRelay(env);
        break;
      case 'error':
        this.options.onError((env.payload as { message?: string })?.message ?? '协作服务返回错误');
        break;
      default:
        break;
    }
  }

  // 鉴权成功后先应用服务端持久化的 Yjs 状态，再建立成员列表、presence 心跳和 P2P 尝试。
  private handleAuthOK(payload: AuthOKPayload) {
    this.connected = true;
    this.options.user = {
      ...this.options.user,
      id: payload.clientId,
      role: payload.isHost ? 'host' : 'collaborator',
      transport: this.options.forceRelay ? 'relay' : 'p2p',
    };
    this.options.onSelf(this.options.user);
    const hasStoredState = Boolean(payload.compactStateBase64 || payload.updates?.length);
    const storedStateVector = hasStoredState ? this.makeStoredStateVector(payload) : undefined;
    if (hasStoredState) {
      this.resetLocalCollaborationState();
      this.nextLocalUpdateStateVector = storedStateVector;
    }
    if (payload.compactStateBase64) {
      Y.applyUpdate(this.options.yDoc, base64ToBytes(payload.compactStateBase64), remoteOrigin);
    }
    payload.updates?.forEach((update) => {
      if (update.updateBase64) {
        Y.applyUpdate(this.options.yDoc, base64ToBytes(update.updateBase64), remoteOrigin);
      }
    });
    this.peerUsers.clear();
    payload.peers?.forEach((peer) => this.upsertPeer(peer));
    this.options.onStatus('已连接');
    this.options.onJoined(this.options.user);
    // 有在线成员时优先等 file DataChannel 就绪再公告素材，避免刚连上就必然走中转。
    this.scheduleResourceTransportReady();
    this.publishPresence();
    this.startPresenceHeartbeat();
    this.startLatencyProbe();
    this.initVoiceClient();
    if (!hasStoredState) {
      this.sendFullStateUpdate();
      window.setTimeout(() => this.sendSnapshot(), 800);
    }
  }

  // 加入审批由服务端转发给房主，但最终决策仍回到同一条 WebSocket 控制通道。
  private handleJoinRequest(payload?: JoinRequestPayload) {
    if (!payload?.requestId || !payload.user) {
      return;
    }
    this.options.onJoinRequest(payload, (approved, reason) => {
      this.sendSocket(
        this.makeEnvelope('join_decision', {
          requestId: payload.requestId,
          clientId: payload.user.id,
          approved,
          reason,
        }),
      );
    });
  }

  private makeOutboundUpdate(update: Uint8Array) {
    if (!this.nextLocalUpdateStateVector) {
      return update;
    }
    const outboundUpdate = Y.encodeStateAsUpdate(this.options.yDoc, this.nextLocalUpdateStateVector);
    this.nextLocalUpdateStateVector = undefined;
    return outboundUpdate;
  }

  // 普通编辑 update 短时间合并，降低拖拽/缩放元素时的网络帧数量。
  private queueDocUpdate(update: Uint8Array) {
    const outboundUpdate = this.makeOutboundUpdate(update);
    this.lastDocInteractionAt = performance.now();
    this.pendingDocUpdates.push(outboundUpdate);
    if (this.pendingDocTimer) {
      return;
    }
    this.pendingDocTimer = window.setTimeout(() => {
      this.pendingDocTimer = undefined;
      this.flushDocUpdates();
    }, docUpdateFlushMs);
  }

  private flushDocUpdates() {
    const updates = this.pendingDocUpdates.splice(0);
    if (updates.length === 0 || !this.connected) {
      return;
    }
    this.broadcastDocUpdate(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
  }

  // 大资源 chunk 使用低优先级队列逐块发送，避免音频传输抢占普通编辑交互。
  private queueResourceUpdate(update: Uint8Array) {
    this.pendingResourceUpdates.push(this.makeOutboundUpdate(update));
    this.scheduleResourceFlush();
  }

  private scheduleResourceFlush(delayMs = resourceUpdateFlushMs) {
    if (this.pendingResourceTimer || this.pendingResourceUpdates.length === 0) {
      return;
    }
    this.pendingResourceTimer = window.setTimeout(() => {
      this.pendingResourceTimer = undefined;
      this.flushNextResourceUpdate();
    }, delayMs);
  }

  private flushNextResourceUpdate() {
    if (!this.connected) {
      this.pendingResourceUpdates = [];
      return;
    }
    if (this.canUseP2PFileTransfer() && !this.canSendToAllPeers('file')) {
      this.markP2PFileTransferActive();
      this.scheduleResourceFlush(fileChannelBackpressureRetryMs);
      return;
    }
    const update = this.pendingResourceUpdates.shift();
    if (update) {
      this.broadcastDocUpdate(update, { resource: true });
    }
    this.scheduleResourceFlush();
  }

  private queueResourceArchive(env: Envelope<DocUpdatePayload>) {
    this.pendingResourceArchiveEnvelopes.push(env);
    this.scheduleResourceArchiveFlush();
  }

  private scheduleResourceArchiveFlush(delayMs = resourceArchiveFlushMs) {
    if (this.pendingResourceArchiveTimer || this.pendingResourceArchiveEnvelopes.length === 0) {
      return;
    }
    this.pendingResourceArchiveTimer = window.setTimeout(() => {
      this.pendingResourceArchiveTimer = undefined;
      this.flushNextResourceArchive();
    }, delayMs);
  }

  private flushNextResourceArchive() {
    if (!this.connected) {
      this.pendingResourceArchiveEnvelopes = [];
      return;
    }
    const now = performance.now();
    const hasRealtimeWork = this.pendingResourceUpdates.length > 0 || this.isP2PFileTransferActive() || now - this.lastDocInteractionAt < resourceArchiveIdleMs;
    if (hasRealtimeWork) {
      this.scheduleResourceArchiveFlush(resourceArchiveFlushMs);
      return;
    }
    const env = this.pendingResourceArchiveEnvelopes.shift();
    if (env) {
      this.sendSocket(env);
    }
    this.scheduleResourceArchiveFlush();
  }

  private queueFileTransfer(transfer: OutboundResourceTransfer) {
    if (!this.connected || !transfer.dataBase64 || this.options.user.id === '') {
      return;
    }
    const dedupeKey = this.fileTransferDedupeKey(transfer);
    // 冷却期内被拒过的素材不再入队（invalidateFileTransferAvailability 写入）。
    const rejectedAt = this.rejectedTransferKeys.get(transfer.key);
    if (rejectedAt && Date.now() - rejectedAt < rejectedTransferCooldownMs) {
      return;
    }
    if (rejectedAt) {
      this.rejectedTransferKeys.delete(transfer.key);
    }
    this.availableFileTransferKeys.add(dedupeKey);
    if (this.pendingFileTransferKeys.has(dedupeKey) || this.activeFileTransferKeys.has(dedupeKey)) {
      return;
    }
    this.pendingFileTransferKeys.add(dedupeKey);
    this.pendingFileTransfers.push(transfer);
    if (!this.sendingFileTransfer) {
      void this.flushFileTransfers();
    }
  }

  private async flushFileTransfers() {
    if (this.sendingFileTransfer) {
      return;
    }
    this.sendingFileTransfer = true;
    try {
      while (this.connected && this.pendingFileTransfers.length > 0) {
        const transfer = this.pendingFileTransfers.shift();
        if (transfer) {
          const dedupeKey = this.fileTransferDedupeKey(transfer);
          this.pendingFileTransferKeys.delete(dedupeKey);
          this.activeFileTransferKeys.add(dedupeKey);
          try {
            await this.sendFileTransfer(transfer);
          } finally {
            this.activeFileTransferKeys.delete(dedupeKey);
          }
        }
      }
    } finally {
      this.sendingFileTransfer = false;
    }
  }

  private async sendFileTransfer(transfer: OutboundResourceTransfer, forcedRoute?: 'p2p' | 'relay') {
    const dataBase64 = transfer.dataBase64;
    const transferId = makeId('file');
    const totalBytes = transfer.asset.size && transfer.asset.size > 0 ? transfer.asset.size : base64ByteLength(dataBase64);
    const totalChunks = Math.max(1, Math.ceil(Math.max(1, dataBase64.length) / fileTransferChunkBase64Chars));
    // 非强制中转时给 file 通道一个短就绪窗口，减少“刚连上就整批走 relay”。
    if (!forcedRoute && !this.options.forceRelay && this.peerUsers.size > 0 && !this.canUseP2PFileTransfer()) {
      await this.waitForP2PFileReady();
    }
    let route: 'p2p' | 'relay' = forcedRoute ?? (this.canUseP2PFileTransfer() ? 'p2p' : 'relay');
    if (route === 'p2p') {
      await this.waitForFileBackpressure();
      if (!this.canUseP2PFileTransfer() || !this.canSendToAllPeers('file')) {
        route = 'relay';
      }
    }
    const startPayload: FileResourceStartPayload = {
      transferId,
      key: transfer.key,
      group: transfer.group,
      asset: transfer.asset,
      signature: transfer.signature,
      transferVersion: transfer.transferVersion,
      totalBytes,
      totalChunks,
      chunkSize: fileTransferChunkBytes,
      relay: route === 'relay',
    };
    const startEnv = this.makeEnvelope('file_resource_start', startPayload);
    if (route === 'p2p') {
      if (!this.sendToAllPeers('file', startEnv)) {
        await this.sendFileTransfer(transfer, 'relay');
        return;
      }
    } else {
      await this.waitForRelaySocketBackpressure();
      this.sendRelayEnvelope(startEnv);
    }
    for (let index = 0; index < totalChunks; index += 1) {
      const chunkBase64 = dataBase64.slice(index * fileTransferChunkBase64Chars, Math.min(dataBase64.length, (index + 1) * fileTransferChunkBase64Chars));
      if (route === 'p2p') {
        // 拥塞（bufferedAmount 高水位）时原地重试同一片；只有 file 通道真正断开才整体转中转。
        // 旧逻辑把"缓冲满"误判为"通道死了"，大文件会反复废弃重来——又慢又停进度。
        let sent = false;
        while (!sent) {
          if (!this.canUseP2PFileTransfer() || !this.connected) {
            await this.sendFileTransfer(transfer, 'relay');
            return;
          }
          await this.waitForFileBackpressure();
          const chunk = base64ToBytes(chunkBase64);
          sent = this.sendBinaryToAllPeers('file', chunk);
          if (!sent) {
            await sleep(fileChannelCongestionRetryMs);
          }
        }
        this.markP2PFileTransferActive();
      } else {
        await this.waitForRelaySocketBackpressure();
        this.sendRelayEnvelope(
          this.makeEnvelope('file_resource_chunk', {
            transferId,
            key: transfer.key,
            index,
            chunkBase64,
            chunkBytes: base64ByteLength(chunkBase64),
            relay: true,
          } satisfies FileResourceChunkPayload),
        );
      }
    }
    const completeEnv = this.makeEnvelope('file_resource_complete', { transferId, key: transfer.key, relay: route === 'relay' } satisfies FileResourceCompletePayload);
    if (route === 'p2p') {
      // 刚发完最后一片时 buffer 可能仍在高水位，先等背压重试几次，通道真断才走中转兜底。
      for (let attempt = 0; attempt < 3 && this.canUseP2PFileTransfer() && this.connected; attempt += 1) {
        await this.waitForFileBackpressure();
        if (this.sendToAllPeers('file', completeEnv)) {
          return;
        }
        await sleep(fileChannelCongestionRetryMs);
      }
    }
    await this.waitForRelaySocketBackpressure();
    this.sendRelayEnvelope(completeEnv);
  }

  // 服务端已有快照时，清理其他客户端的协作用快照，但保留本地当前的 entry。
  // 如果全部清空再应用服务端状态，会导致本地方主刚刚插入的元素/资源被"回滚"消失。
  private resetLocalCollaborationState() {
    const localClientID = String(this.options.yDoc.clientID);
    const localDocKey = collaborationDocumentKeyPrefix + localClientID;
    this.options.yDoc.transact(() => {
      const snapshots = this.options.yDoc.getMap('snapshot');
      Array.from(snapshots.keys()).forEach((key) => {
        if (key === localDocKey) {
          return;
        }
        if (key === 'document' || key.startsWith(collaborationDocumentKeyPrefix)) {
          snapshots.delete(key);
        }
      });
    }, remoteOrigin);
  }

  // 用服务端 compact_state + updates 构造 state vector，让下一次本地编辑只补发真正缺失的差量。
  private makeStoredStateVector(payload: AuthOKPayload) {
    const baseline = new Y.Doc();
    try {
      if (payload.compactStateBase64) {
        Y.applyUpdate(baseline, base64ToBytes(payload.compactStateBase64));
      }
      payload.updates?.forEach((update) => {
        if (update.updateBase64) {
          Y.applyUpdate(baseline, base64ToBytes(update.updateBase64));
        }
      });
      return Y.encodeStateVector(baseline);
    } finally {
      baseline.destroy();
    }
  }

  private broadcastDocUpdate(update: Uint8Array, options: { resource?: boolean } = {}) {
    // 同一个浏览器标签会复用 sessionStorage 里的 user.id。
    // 协作者退出后重新加入时 updateSeq 会从 0 开始，如果 updateId 只用 user.id + seq，
    // 其他客户端会把新连接的编辑误判为旧连接已处理过的 update。connectionId 用于隔离每次连接生命周期。
    const updateId = `${this.options.user.id}:${this.connectionId}:${++this.updateSeq}`;
    rememberSeenId(this.seenUpdates, updateId);
    const payload: DocUpdatePayload = {
      updateId,
      updateBase64: bytesToBase64(update),
      // 服务端仍负责持久化与必要中转；资源走 P2P file 通道时会延后归档，避免和实时编辑抢带宽。
      relay: true,
    };
    const env = this.makeEnvelope('doc_update', payload);
    if (options.resource && this.canUseP2PFileTransfer()) {
      if (this.sendToAllPeers('file', env)) {
        this.markP2PFileTransferActive();
        this.queueResourceArchive(env);
        return;
      }
    }
    if (!this.isP2PFileTransferActive()) {
      this.sendToPeers('doc', env);
    }
    this.sendSocket(env);
    if (options.resource) {
      return;
    }
    this.snapshotCounter += 1;
    if (this.snapshotCounter >= 50) {
      this.snapshotCounter = 0;
      this.sendSnapshot();
    }
  }

  // 新房间或空房间没有服务端历史时，主动发一次完整状态，保证后加入者能从 SQLite 恢复。
  private sendFullStateUpdate() {
    if (!this.connected) {
      return;
    }
    const updateId = `${this.options.user.id}:${this.connectionId}:state:${++this.updateSeq}`;
    rememberSeenId(this.seenUpdates, updateId);
    const env = this.makeEnvelope('doc_update', {
      updateId,
      updateBase64: bytesToBase64(Y.encodeStateAsUpdate(this.options.yDoc)),
      relay: true,
    } satisfies DocUpdatePayload);
    this.sendToPeers('doc', env);
    this.sendSocket(env);
  }

  // Yjs update 是幂等叠加模型；这里只需要按 updateId 去重，然后交给 Yjs 合并。
  private applyDocUpdate(payload?: DocUpdatePayload) {
    if (!payload?.updateBase64 || this.seenUpdates.has(payload.updateId)) {
      return;
    }
    rememberSeenId(this.seenUpdates, payload.updateId);
    Y.applyUpdate(this.options.yDoc, base64ToBytes(payload.updateBase64), remoteOrigin);
  }

  private applyFileResourceStart(peerId: string, payload?: FileResourceStartPayload) {
    if (!payload?.transferId || !payload.key || peerId === this.options.user.id) {
      return;
    }
    if (this.availableFileTransferKeys.has(this.fileTransferDedupeKeyFromPayload(payload))) {
      return;
    }
    // 对端声明的传输参数不可信：总大小、分片数、MIME、文件名都校验后才建会话。
    if (!isValidIncomingTransfer(payload)) {
      return;
    }
    // 单个对端的并发会话数设限，防止伪造 transfer 刷内存。
    let peerSessions = 0;
    this.incomingFileTransfers.forEach((session) => {
      if (session.peerId === peerId) {
        peerSessions += 1;
      }
    });
    if (peerSessions >= maxIncomingSessionsPerPeer) {
      return;
    }
    const sessionKey = this.fileSessionKey(peerId, payload.transferId);
    this.clearIncomingFileSessions(peerId, payload.key);
    this.incomingFileTransfers.set(sessionKey, {
      peerId,
      start: payload,
      chunks: [],
      receivedBytes: 0,
      receivedChunks: 0,
      lastActivityAt: Date.now(),
    });
    announceResourceTransferProgress(this.fileProgress(payload, 0, 0));
  }

  private applyFileResourceChunk(peerId: string, payload?: FileResourceChunkPayload) {
    if (!payload?.transferId || typeof payload.chunkBase64 !== 'string' || peerId === this.options.user.id) {
      return;
    }
    this.appendFileChunk(peerId, payload.transferId, payload.chunkBase64, payload.index, payload.chunkBytes);
  }

  private async applyFileBinaryChunk(peerId: string, data: ArrayBuffer | Blob) {
    // P2P 二进制分片不带 transferId（省开销），按"最近活跃的未完成会话"归属：
    // 发送端串行出队（sendingFileTransfer），同一时刻对每个对端只有一个活跃传输。
    const sessions = Array.from(this.incomingFileTransfers.values()).filter((session) => session.peerId === peerId && session.receivedChunks < session.start.totalChunks);
    const session = sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (!session) {
      return;
    }
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
    this.appendFileChunk(peerId, session.start.transferId, bytes);
  }

  private async applyFileResourceComplete(peerId: string, payload?: FileResourceCompletePayload) {
    if (!payload?.transferId || peerId === this.options.user.id) {
      return;
    }
    const sessionKey = this.fileSessionKey(peerId, payload.transferId);
    const session = this.incomingFileTransfers.get(sessionKey);
    if (!session || session.receivedChunks < session.start.totalChunks) {
      return;
    }
    // start.totalBytes 来自对端 asset.size 元数据，存在两种口径：文件导入=原始字节，
    // 粘贴/裁剪=createAssetFromDataUrl 的 dataUrl.length（比字节大约 33%）。
    // 分片收满（上面的 receivedChunks 判断）才是"收齐"信号；尺寸只挡数量级异常
    //（低于两种口径下限的 95%），完整性由 SHA-256 判定。
    const sizeFloorBytes = Math.floor(session.start.totalBytes * 0.95);
    const sizeFloorDataUrl = Math.floor(sizeFloorBytes / 1.4);
    if (session.receivedBytes < Math.min(sizeFloorBytes, sizeFloorDataUrl)) {
      this.rejectIncomingTransfer(session, sessionKey, 'incomplete');
      return;
    }
    const dataBase64 = encodeFileTransferChunks(session.chunks);
    if (!(await verifyIncomingTransferHash(session.start, dataBase64))) {
      await this.diagnoseRejectedHash(session);
      this.rejectIncomingTransfer(session, sessionKey, 'hash_mismatch');
      return;
    }
    announceCompletedResourceTransfer({
      key: session.start.key,
      group: session.start.group,
      asset: sanitizeIncomingAsset(session.start.asset),
      signature: session.start.signature,
      transferVersion: session.start.transferVersion,
      dataBase64,
    });
    this.availableFileTransferKeys.add(this.fileTransferDedupeKeyFromPayload(session.start));
    this.incomingFileTransfers.delete(sessionKey);
  }

  // 传输被拒时清掉进度条并公告失效：房主端 invalidateFileTransferAvailability 会移除"已传输"标记，
  // 下次资源公告重新走传输，而不是让接收端永远停在 99%。
  private rejectIncomingTransfer(session: IncomingFileTransfer, sessionKey: string, reason: string) {
    this.incomingFileTransfers.delete(sessionKey);
    logFrontend('warn', `素材传输被拒绝 key=${session.start.key} reason=${reason}`);
    announceResourceTransferInvalidated({
      key: session.start.key,
      group: session.start.group,
      assetId: session.start.asset.id,
    });
  }

  // 诊断：被拒时把双口径 hash 前缀带进日志，便于口径漂移排查。
  private async diagnoseRejectedHash(session: IncomingFileTransfer) {
    try {
      const present = session.chunks.filter((c): c is string | Uint8Array => c !== undefined);
      let b64 = '';
      if (present.every((c): c is string => typeof c === 'string')) {
        b64 = present.join('');
      } else if (present.length > 0) {
        let total = 0;
        present.forEach((c) => { total += c.length; });
        const all = new Uint8Array(total);
        let off = 0;
        present.forEach((c) => {
          const bytes = typeof c === 'string' ? base64ToBytes(c) : c;
          all.set(bytes, off);
          off += bytes.length;
        });
        b64 = bytesToBase64(all);
      }
      const bytes = base64ToBytes(b64);
      const hexOf = async (input: ArrayBuffer | Uint8Array) => {
        const d = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
        return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
      };
      const mime = session.start.asset.mimeType || 'application/octet-stream';
      logFrontend('warn', `hash诊断 claimed=${session.start.asset.hash.slice(0, 20)} bytes=${(await hexOf(bytes)).slice(0, 20)} dataurl=${(await hexOf(new TextEncoder().encode(`data:${mime};base64,${b64}`))).slice(0, 20)} b64len=${b64.length} chunkKinds=${present.slice(0, 3).map((c) => (typeof c === 'string' ? 's' : 'u') + c.length).join(',')}`);
    } catch {
      // 诊断失败不影响主流程
    }
  }

  private appendFileChunk(peerId: string, transferId: string, chunk: string | Uint8Array, index?: number, byteLength?: number) {
    const sessionKey = this.fileSessionKey(peerId, transferId);
    const session = this.incomingFileTransfers.get(sessionKey);
    if (!session) {
      return;
    }
    const chunkIndex = index ?? session.receivedChunks;
    if (session.chunks[chunkIndex] === undefined) {
      session.chunks[chunkIndex] = chunk;
      session.receivedChunks += 1;
      session.receivedBytes += byteLength ?? (typeof chunk === 'string' ? base64ByteLength(chunk) : chunk.length);
    }
    session.lastActivityAt = Date.now();
    announceResourceTransferProgress(this.fileProgress(session.start, session.receivedBytes, session.receivedChunks));
    if (session.receivedChunks >= session.start.totalChunks) {
      void this.applyFileResourceComplete(peerId, { transferId, key: session.start.key });
    }
  }

  private fileProgress(start: FileResourceStartPayload, receivedBytes: number, receivedChunks: number) {
    return {
      key: start.key,
      group: start.group,
      assetId: start.asset.id,
      name: start.asset.name,
      receivedChunks,
      totalChunks: start.totalChunks,
      receivedBytes,
      totalBytes: Math.max(1, start.totalBytes),
      progress: Math.min(0.99, receivedBytes / Math.max(1, start.totalBytes)),
    };
  }

  private fileSessionKey(peerId: string, transferId: string) {
    return `${peerId}:${transferId}`;
  }

  private clearIncomingFileSessions(peerId: string, resourceKeyValue: string) {
    Array.from(this.incomingFileTransfers.entries()).forEach(([key, session]) => {
      if (session.peerId === peerId && session.start.key === resourceKeyValue) {
        this.incomingFileTransfers.delete(key);
      }
    });
  }

  private invalidateFileTransferAvailability(invalidation: ResourceTransferInvalidation) {
    const prefix = `${invalidation.key}:`;
    Array.from(this.availableFileTransferKeys).forEach((key) => {
      if (key.startsWith(prefix)) {
        this.availableFileTransferKeys.delete(key);
      }
    });
    Array.from(this.pendingFileTransferKeys).forEach((key) => {
      if (key.startsWith(prefix)) {
        this.pendingFileTransferKeys.delete(key);
      }
    });
    Array.from(this.activeFileTransferKeys).forEach((key) => {
      if (key.startsWith(prefix)) {
        this.activeFileTransferKeys.delete(key);
      }
    });
    this.pendingFileTransfers = this.pendingFileTransfers.filter((transfer) => transfer.key !== invalidation.key);
    Array.from(this.incomingFileTransfers.entries()).forEach(([key, session]) => {
      if (session.start.key === invalidation.key) {
        this.incomingFileTransfers.delete(key);
      }
    });
    // 记录拒绝时间并清掉缓存的重传队列：同一素材短期内不再自动重发，
    // 否则"校验失败→重发→再失败"会形成带宽空转的循环。
    this.rejectedTransferKeys.set(invalidation.key, Date.now());
    this.pendingResourceUpdates = this.pendingResourceUpdates.filter(
      (env) => !(env as { payload?: { key?: string } }).payload?.key || ((env as { payload?: { key?: string } }).payload as { key?: string }).key !== invalidation.key,
    );
  }

  // 校验失败素材的冷却表：冷却期内资源公告跳过该 key，之后允许再试（可能是暂时性损坏）。
  private rejectedTransferKeys = new Map<string, number>();

  private fileTransferDedupeKey(transfer: OutboundResourceTransfer) {
    return `${transfer.key}:${transfer.signature}:${transfer.transferVersion ?? ''}`;
  }

  private fileTransferDedupeKeyFromPayload(payload: Pick<FileResourceStartPayload, 'key' | 'signature' | 'transferVersion'>) {
    return `${payload.key}:${payload.signature}:${payload.transferVersion ?? ''}`;
  }

  // 自动快照只做小文档兜底，超过阈值就继续依赖增量队列，避免大素材反复写入服务端。
  private sendSnapshot() {
    if (!this.connected) {
      return;
    }
    const state = Y.encodeStateAsUpdate(this.options.yDoc);
    if (state.length > maxAutomaticSnapshotBytes) {
      return;
    }
    this.sendSocket(
      this.makeEnvelope('doc_snapshot', {
        stateBase64: bytesToBase64(state),
      }),
    );
  }

  // Presence 同时承担在线状态、远端光标和实际传输路径展示；P2P 未连通时仍会通过服务端低频保活。
  private publishPresence() {
    if (!this.connected) {
      return;
    }
    this.lastPresenceSentAt = performance.now();
    const transport: Transport = this.options.forceRelay ? 'relay' : this.hasAnyOpenChannel('presence') ? 'p2p' : 'relay';
    const user = { ...this.options.user, transport, lastSeen: new Date().toISOString() };
    this.options.user = user;
    const relay = this.needsRelay('presence') || this.isP2PFileTransferActive();
    const env = this.makeEnvelope('presence', { user, relay });
    if (!this.isP2PFileTransferActive()) {
      this.sendToPeers('presence', env);
    }
    const now = performance.now();
    if (relay || now - this.lastServerPresenceAt >= serverPresenceMinIntervalMs) {
      this.lastServerPresenceAt = now;
      this.sendSocket(env);
    }
  }

  private startPresenceHeartbeat() {
    if (this.presenceTimer) {
      window.clearInterval(this.presenceTimer);
    }
    this.presenceTimer = window.setInterval(() => this.publishPresence(), 1500);
    this.startIncomingFileSweeper();
  }

  // 清扫超时的传入传输会话：对端中途消失时释放并发名额，避免后续素材传输被卡。
  private startIncomingFileSweeper() {
    if (this.incomingFileSweepTimer) {
      window.clearInterval(this.incomingFileSweepTimer);
    }
    this.incomingFileSweepTimer = window.setInterval(() => {
      const now = Date.now();
      Array.from(this.incomingFileTransfers.entries()).forEach(([key, session]) => {
        if (now - session.lastActivityAt > incomingFileSessionTimeoutMs) {
          logFrontend('warn', `素材传输超时清理 key=${session.start.key} received=${session.receivedChunks}/${session.start.totalChunks}`);
          this.rejectIncomingTransfer(session, key, 'timeout');
        }
      });
    }, incomingFileSweepIntervalMs);
  }

  // 光标移动比普通 presence 高频，所以 schedulePresence 会按最小间隔节流。
  private schedulePresence(delayMs: number) {
    if (!this.connected) {
      return;
    }
    const elapsed = performance.now() - this.lastPresenceSentAt;
    const delay = Math.max(0, delayMs - elapsed);
    if (delay === 0) {
      if (this.pendingPresenceTimer) {
        window.clearTimeout(this.pendingPresenceTimer);
        this.pendingPresenceTimer = undefined;
      }
      this.publishPresence();
      return;
    }
    if (!this.pendingPresenceTimer) {
      this.pendingPresenceTimer = window.setTimeout(() => {
        this.pendingPresenceTimer = undefined;
        this.publishPresence();
      }, delay);
    }
  }

  // 从 P2P 收到的 presence 比服务端中转更能证明直连成功，因此 source=p2p 会覆盖传输状态。
  private applyPresence(user?: PresenceUser, source: Transport = 'relay') {
    if (!user || user.id === this.options.user.id) {
      return;
    }
    const previous = this.peerUsers.get(user.id);
    const transport = source === 'p2p' ? 'p2p' : (user.transport ?? previous?.transport ?? source);
    this.peerUsers.set(user.id, { ...previous, ...user, transport });
    this.ensurePeer(user);
    this.emitPeers();
  }

  private applyChat(env: Envelope) {
    const payload = env.payload as { messageId?: string; text?: string; user?: PresenceUser };
    if (!payload?.messageId || !payload.text || this.seenChats.has(payload.messageId)) {
      return;
    }
    rememberSeenId(this.seenChats, payload.messageId);
    this.options.onChat({
      id: payload.messageId,
      text: payload.text,
      user: payload.user ?? this.peerUsers.get(env.from ?? '') ?? this.options.user,
      sentAt: env.sentAt ?? new Date().toISOString(),
    });
  }

  private startLatencyProbe() {
    if (this.latencyTimer) {
      window.clearInterval(this.latencyTimer);
    }
    this.sendPing();
    this.latencyTimer = window.setInterval(() => this.sendPing(), latencyProbeIntervalMs);
  }

  private sendPing() {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const pingId = makeId('ping');
    this.pendingPings.set(pingId, performance.now());
    this.sendSocket(this.makeEnvelope('ping', { pingId } satisfies PingPayload));
    if (this.pendingPings.size > 8) {
      const oldest = this.pendingPings.keys().next().value;
      if (oldest) {
        this.pendingPings.delete(oldest);
      }
    }
  }

  private applyPong(payload?: PongPayload) {
    if (!payload?.pingId) {
      return;
    }
    const startedAt = this.pendingPings.get(payload.pingId);
    if (startedAt === undefined) {
      return;
    }
    this.pendingPings.delete(payload.pingId);
    this.options.onLatency(Math.max(0, Math.round(performance.now() - startedAt)));
  }

  // 服务端 relay envelope 外层 type 固定为 relay，内层 payload.type 才是真实业务类型。
  private handleRelay(env: Envelope) {
    const payload = env.payload as { type?: string; payload?: unknown };
    if (!payload?.type) {
      return;
    }
    this.handleEnvelope({ ...env, type: payload.type, payload: payload.payload }, 'relay');
  }

  private upsertPeer(peer?: PresenceUser, notify = false) {
    if (!peer || peer.id === this.options.user.id) {
      return;
    }
    const isNewPeer = !this.peerUsers.has(peer.id);
    this.peerUsers.set(peer.id, peer);
    this.ensurePeer(peer);
    this.emitPeers();
    if (isNewPeer) {
      // 新 peer 加入后同样先等 file 通道，避免立即重传素材落到中转。
      this.scheduleResourceTransportReady();
      this.voiceClient?.handlePeerConnected(peer.id);
      if (notify) {
        this.options.onPeerJoined(peer);
      }
    }
  }

  private removePeer(peerID: string) {
    const leavingUser = this.peerUsers.get(peerID) ?? this.peers.get(peerID)?.user;
    this.peerUsers.delete(peerID);
    const peer = this.peers.get(peerID);
    if (peer) {
      window.clearTimeout(peer.timer);
      peer.pc.close();
      this.peers.delete(peerID);
    }
    this.emitPeers();
    this.voiceClient?.handlePeerDisconnected(peerID);
    if (leavingUser) {
      this.options.onPeerLeft({ ...leavingUser, transport: 'offline' });
    }
  }

  private emitPeers() {
    this.options.onPeers(Array.from(this.peerUsers.values()));
  }

  // 每看到一个在线成员就尝试建立一条 WebRTC 连接；失败不会阻断协作，因为 WebSocket relay 仍在。
  private ensurePeer(user: PresenceUser) {
    if (this.options.forceRelay || this.peers.has(user.id)) {
      return;
    }
    // 部分 Android WebView / 受限环境可能没有 RTCPeerConnection；直接降级为 relay。
    if (typeof RTCPeerConnection === 'undefined') {
      this.peerUsers.set(user.id, { ...(this.peerUsers.get(user.id) ?? user), transport: 'relay' });
      this.emitPeers();
      return;
    }
    // iceServers 优先使用联机服务器返回的内置 STUN，再合并本地调试配置。
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: this.iceServers() });
    } catch {
      this.peerUsers.set(user.id, { ...(this.peerUsers.get(user.id) ?? user), transport: 'relay' });
      this.emitPeers();
      return;
    }
    const peer: PeerConnection = { id: user.id, user, pc, channels: {}, timer: 0 };
    this.peers.set(user.id, peer);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSocket(this.makeEnvelope('signal', { kind: 'ice', candidate: event.candidate.toJSON() }, user.id));
      }
    };
    pc.ondatachannel = (event) => this.attachChannel(peer, event.channel);
    pc.onconnectionstatechange = () => {
      // 这里只更新展示状态和 relay 判定；真正的数据兜底由 needsRelay/sendSocket 决定。
      const next = pc.connectionState === 'connected' ? 'p2p' : pc.connectionState === 'failed' || pc.connectionState === 'disconnected' ? 'relay' : undefined;
      if (next) {
        this.peerUsers.set(user.id, { ...(this.peerUsers.get(user.id) ?? user), transport: next });
        this.emitPeers();
      }
    };
    dataChannelNames.forEach((name) => {
      // 用 clientId 字典序决定谁创建 DataChannel，避免两端都主动创建出重复通道。
      if (this.options.user.id < user.id) {
        this.attachChannel(peer, pc.createDataChannel(name, channelOptions(name)));
      }
    });
    peer.timer = window.setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        this.peerUsers.set(user.id, { ...(this.peerUsers.get(user.id) ?? user), transport: 'relay' });
        this.emitPeers();
      }
    }, 8000);
    if (this.options.user.id < user.id) {
      void this.createOffer(peer);
    }
  }

  // DataChannel 打开后，同一套 Envelope 处理逻辑会以 source=p2p 执行，方便 presence 标记真实路径。
  private attachChannel(peer: PeerConnection, channel: RTCDataChannel) {
    const label = dataChannelNames.includes(channel.label as any) ? (channel.label as keyof PeerConnection['channels']) : 'doc';
    peer.channels[label] = channel;
    channel.onopen = () => {
      this.peerUsers.set(peer.id, { ...(this.peerUsers.get(peer.id) ?? peer.user), transport: 'p2p' });
      this.emitPeers();
      if (label === 'file') {
        // file 通道真正 open 后立刻放开资源公告；若仍有其他 peer 未就绪，schedule 会继续等待。
        this.scheduleResourceTransportReady();
      }
    };
    channel.onmessage = (event) => {
      if (label === 'file' && typeof event.data !== 'string') {
        void this.applyFileBinaryChunk(peer.id, event.data as ArrayBuffer | Blob);
        return;
      }
      if (label === 'voice' && typeof event.data !== 'string') {
        this.voiceClient?.handleVoiceChunk(peer.id, event.data as ArrayBuffer);
        return;
      }
      const env = parseEnvelopeSafe(event.data);
      if (env) {
        this.handleEnvelope(env, 'p2p');
      }
    };
  }

  private async createOffer(peer: PeerConnection) {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.sendSocket(this.makeEnvelope('signal', { kind: 'offer', sdp: offer.sdp }, peer.id));
  }

  // 信令只通过 WebSocket 交换 SDP/ICE；浏览器 ICE 过程会自行使用 STUN 探测公网映射。
  private async handleSignal(peerID: string, signal?: SignalPayload) {
    const user = this.peerUsers.get(peerID);
    if (!peerID || !signal || !user) {
      return;
    }
    this.ensurePeer(user);
    const peer = this.peers.get(peerID);
    if (!peer) {
      return;
    }
    if (signal.kind === 'offer' && signal.sdp) {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.sendSocket(this.makeEnvelope('signal', { kind: 'answer', sdp: answer.sdp }, peerID));
    } else if (signal.kind === 'answer' && signal.sdp) {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.kind === 'ice' && signal.candidate) {
      await peer.pc.addIceCandidate(signal.candidate);
    }
  }

  private sendToPeers(channelName: DataChannelName, env: Envelope) {
    if (this.options.forceRelay) {
      return false;
    }
    let sent = false;
    const encoded = JSON.stringify(env);
    this.peers.forEach((peer) => {
      const channel = peer.channels[channelName];
      if (channel?.readyState === 'open' && channel.bufferedAmount < this.bufferedAmountLimit(channelName)) {
        try {
          channel.send(encoded);
        } catch {
          return;
        }
        sent = true;
      }
    });
    return sent;
  }

  private sendToAllPeers(channelName: DataChannelName, env: Envelope) {
    if (this.options.forceRelay || !this.canSendToAllPeers(channelName)) {
      return false;
    }
    const encoded = JSON.stringify(env);
    try {
      Array.from(this.peerUsers.keys()).forEach((peerID) => {
        this.peers.get(peerID)?.channels[channelName]?.send(encoded);
      });
      return true;
    } catch {
      return false;
    }
  }

  private sendBinaryToAllPeers(channelName: DataChannelName, data: Uint8Array) {
    if (this.options.forceRelay || !this.canSendToAllPeers(channelName)) {
      return false;
    }
    const payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    try {
      Array.from(this.peerUsers.keys()).forEach((peerID) => {
        this.peers.get(peerID)?.channels[channelName]?.send(payload);
      });
      return true;
    } catch {
      return false;
    }
  }

  private sendSocket(env: Envelope) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(env));
    }
  }

  private sendRelayEnvelope(env: Envelope) {
    this.sendSocket(
      this.makeEnvelope(
        'relay',
        {
          type: env.type,
          payload: env.payload,
        },
        env.to ?? '',
      ),
    );
  }

  // P2P 未全部打开时，业务消息仍需要发给服务端一份，作为应用层 TURN-like 兜底。
  private needsRelay(channelName: RealtimeChannelName) {
    if (this.options.forceRelay) {
      return true;
    }
    const peerIDs = Array.from(this.peerUsers.keys());
    if (peerIDs.length === 0) {
      return false;
    }
    return peerIDs.some((peerID) => this.peers.get(peerID)?.channels[channelName]?.readyState !== 'open');
  }

  private hasAnyOpenChannel(channelName: RealtimeChannelName) {
    return Array.from(this.peers.values()).some((peer) => peer.channels[channelName]?.readyState === 'open');
  }

  private canUseP2PFileTransfer() {
    if (this.options.forceRelay) {
      return false;
    }
    const peerIDs = Array.from(this.peerUsers.keys());
    return peerIDs.length > 0 && peerIDs.every((peerID) => this.peers.get(peerID)?.channels.file?.readyState === 'open');
  }

  // 资源公告/发送前的短等待：优先吃到 P2P file，超时后仍允许走中转兜底。
  private async waitForP2PFileReady(timeoutMs = p2pFileReadyWaitMs) {
    if (!this.connected || this.closing || this.options.forceRelay || this.peerUsers.size === 0) {
      return false;
    }
    if (this.canUseP2PFileTransfer()) {
      return true;
    }
    const startedAt = performance.now();
    while (this.connected && !this.closing && performance.now() - startedAt < timeoutMs) {
      if (this.canUseP2PFileTransfer()) {
        return true;
      }
      await sleep(p2pFileReadyPollMs);
    }
    return this.canUseP2PFileTransfer();
  }

  // 合并资源公告：有 peer 且 file 未齐时等待，避免 auth_ok/peer_joined 连发多次中转传输。
  private scheduleResourceTransportReady() {
    if (!this.connected || this.closing) {
      return;
    }
    if (this.options.forceRelay || this.peerUsers.size === 0 || this.canUseP2PFileTransfer()) {
      this.flushResourceTransportReady();
      return;
    }
    if (this.resourceTransportReadyTimer) {
      return;
    }
    this.resourceTransportWaitStartedAt = performance.now();
    this.resourceTransportReadyTimer = window.setInterval(() => {
      if (!this.connected || this.closing) {
        this.clearResourceTransportReadyTimer();
        return;
      }
      if (this.options.forceRelay || this.canUseP2PFileTransfer() || performance.now() - this.resourceTransportWaitStartedAt >= p2pFileReadyWaitMs) {
        this.flushResourceTransportReady();
      }
    }, p2pFileReadyPollMs);
  }

  private flushResourceTransportReady() {
    this.clearResourceTransportReadyTimer();
    if (!this.connected || this.closing) {
      return;
    }
    announceResourceTransportReady();
  }

  private clearResourceTransportReadyTimer() {
    if (this.resourceTransportReadyTimer) {
      window.clearInterval(this.resourceTransportReadyTimer);
      this.resourceTransportReadyTimer = undefined;
    }
  }

  private canSendToAllPeers(channelName: DataChannelName) {
    if (this.options.forceRelay) {
      return false;
    }
    const peerIDs = Array.from(this.peerUsers.keys());
    if (peerIDs.length === 0) {
      return false;
    }
    return peerIDs.every((peerID) => {
      const channel = this.peers.get(peerID)?.channels[channelName];
      return Boolean(channel && channel.readyState === 'open' && channel.bufferedAmount < this.bufferedAmountLimit(channelName));
    });
  }

  private bufferedAmountLimit(channelName: DataChannelName) {
    return channelName === 'file' ? maxFileChannelBufferedBytes : maxDataChannelBufferedBytes;
  }

  private async waitForFileBackpressure() {
    while (this.connected && this.canUseP2PFileTransfer() && !this.canSendToAllPeers('file')) {
      this.markP2PFileTransferActive();
      await sleep(fileChannelCongestionRetryMs);
    }
  }

  private async waitForRelaySocketBackpressure() {
    while (this.connected && this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount > maxRelaySocketBufferedBytes) {
      await sleep(relaySocketBackpressureRetryMs);
    }
  }

  private markP2PFileTransferActive() {
    this.p2pFileTransferActiveUntil = performance.now() + resourceTransferIdleMs;
  }

  private isP2PFileTransferActive() {
    return performance.now() < this.p2pFileTransferActiveUntil;
  }

  private initVoiceClient(): void {
    if (this.voiceClient) {
      this.voiceClient.destroy();
    }
    this.voiceClient = new VoiceClient({
      selfId: this.options.user.id,
      iceServers: this.iceServers(),
      sendSignal: (peerId, signal) => this.sendVoiceSignalEnvelope(peerId, signal),
      sendRelayChunk: (chunk) => this.sendVoiceRelayChunk(chunk),
      sendVoiceControl: (ctrl) => this.sendVoiceControlEnvelope(ctrl),
      onChange: (state) => this.options.onVoiceState?.(state),
    });
    // 为已有对等方建立连接。
    this.peerUsers.forEach((_, peerId) => {
      this.voiceClient?.handlePeerConnected(peerId);
    });
  }

  private sendVoiceSignalEnvelope(peerId: string, signal: VoiceSignal): void {
    this.sendSocket(this.makeEnvelope('voice_signal', signal, peerId));
  }

  private sendVoiceRelayChunk(chunk: ArrayBuffer): void {
    if (!this.connected) {
      return;
    }
    // 优先 P2P voice DataChannel；失败时走 WebSocket relay。
    if (!this.options.forceRelay && this.canSendToAllPeers('voice')) {
      this.sendBinaryToAllPeers('voice', new Uint8Array(chunk));
      // 同时 relay 一份给无法 P2P 的对等方。
      const relayNeeded = this.needsRelay('voice');
      if (relayNeeded) {
        this.sendRelayEnvelope(
          this.makeEnvelope('voice_data', { chunkBase64: bytesToBase64(new Uint8Array(chunk)) }),
        );
      }
    } else {
      this.sendRelayEnvelope(
        this.makeEnvelope('voice_data', { chunkBase64: bytesToBase64(new Uint8Array(chunk)) }),
      );
    }
  }

  private handleVoiceDataRelay(env: Envelope): void {
    const payload = env.payload as VoiceDataPayload;
    if (!payload?.chunkBase64 || !env.from) {
      return;
    }
    try {
      const chunk = base64ToBytes(payload.chunkBase64);
      this.voiceClient?.handleVoiceChunk(env.from, chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
    } catch {
      // 解码失败静默丢弃。
    }
  }

  private sendVoiceControlEnvelope(ctrl: 'stop'): void {
    if (!this.connected) {
      return;
    }
    const env = this.makeEnvelope('voice_ctrl', { ctrl });
    // 通过 voice DataChannel P2P 发送，同时 relay 一份。
    this.sendToPeers('voice', env);
    this.sendRelayEnvelope(env);
  }

  private clearTimers() {
    if (this.presenceTimer) {
      window.clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
    if (this.pendingPresenceTimer) {
      window.clearTimeout(this.pendingPresenceTimer);
      this.pendingPresenceTimer = undefined;
    }
    if (this.latencyTimer) {
      window.clearInterval(this.latencyTimer);
      this.latencyTimer = undefined;
    }
    if (this.incomingFileSweepTimer) {
      window.clearInterval(this.incomingFileSweepTimer);
      this.incomingFileSweepTimer = undefined;
    }
    if (this.pendingDocTimer) {
      window.clearTimeout(this.pendingDocTimer);
      this.pendingDocTimer = undefined;
    }
    if (this.pendingResourceTimer) {
      window.clearTimeout(this.pendingResourceTimer);
      this.pendingResourceTimer = undefined;
    }
    if (this.pendingResourceArchiveTimer) {
      window.clearTimeout(this.pendingResourceArchiveTimer);
      this.pendingResourceArchiveTimer = undefined;
    }
    this.clearResourceTransportReadyTimer();
  }

  private makeEnvelope<T>(type: string, payload: T, to = ''): Envelope<T> {
    return {
      v: 1,
      type,
      id: makeId('msg'),
      from: this.options.user.id,
      to,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  // 标准 ICE server 列表只放浏览器能识别的 stun/turn 地址；当前项目中转不是标准 turn: 服务。
  private iceServers(): RTCIceServer[] {
    return mergeIceServers(this.options.iceServers ?? [], storedIceServers());
  }
}

// 创建房间走 HTTP API；响应里的 wsUrl 用于 WebSocket，iceServers 用于 RTCPeerConnection。
export async function createCollaborationRoom(serverAddress: string, appUrl: string): Promise<CreateRoomResult> {
  const serverUrl = normalizeHttpServerUrl(serverAddress);
  const endpoint = new URL('/api/rooms', serverUrl);
  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, appUrl }),
    });
  } catch (error) {
    throw new Error(formatRoomCreateNetworkError(serverUrl, error));
  }
  if (!response.ok) {
    let message = '创建协作房间失败';
    try {
      const payload = (await response.json()) as { message?: string };
      message = payload.message || message;
    } catch {
      message = `${message}：HTTP ${response.status}`;
    }
    throw new Error(message);
  }
  return (await response.json()) as CreateRoomResult;
}

// UI 允许用户填 http/https/ws/wss，这里统一规整成 HTTP 基地址，供创建房间和 STUN URL 推导使用。
export function normalizeHttpServerUrl(serverAddress: string) {
  const raw = withDefaultScheme(serverAddress.trim() || 'http://127.0.0.1:8787', 'http://');
  const url = new URL(raw);
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('服务器地址需要使用 http、https、ws 或 wss');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

// 手动加入房间不走创建接口时，需要从同一个服务地址推导 WebSocket 入口。
export function serverAddressToWsUrl(serverAddress: string) {
  const raw = withDefaultScheme(serverAddress.trim() || 'http://127.0.0.1:8787', 'http://');
  const url = new URL(raw);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('服务器地址需要使用 http、https、ws 或 wss');
  }
  url.pathname = '/ws/collab';
  url.search = '';
  url.hash = '';
  return url.toString();
}

// 邀请链接或手动地址里没有服务端返回值时，按同主机同端口生成内置 STUN 地址。
export function iceServersFromServerAddress(serverAddress: string): RTCIceServer[] {
  const serverUrl = normalizeHttpServerUrl(serverAddress);
  const url = new URL(serverUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const host = url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname;
  return [{ urls: [`stun:${host}:${port}`] }];
}

// 邀请链接把 roomKey 放在 hash fragment；浏览器不会把 fragment 发给 HTTP 服务和反向代理。
export function parseInviteLink(value: string): InviteInfo {
  const raw = value.trim();
  if (!raw) {
    throw new Error('请先粘贴邀请链接');
  }
  const link = new URL(raw, window.location.href);
  const fragmentParams = new URLSearchParams(link.hash.replace(/^#/, ''));
  const serverUrl = fragmentParams.get('server') || link.searchParams.get('server') || '';
  const roomId = fragmentParams.get('roomId') || link.searchParams.get('roomId') || '';
  // roomKey 只从 fragment 读取：query 会被代理/服务器记录并出现在 Referer 中，不接受弱传输形式。
  const roomKey = fragmentParams.get('roomKey') || '';
  if (!serverUrl || !roomId || !roomKey) {
    throw new Error('邀请链接缺少服务器、房间或密钥信息');
  }
  return {
    serverUrl: normalizeHttpServerUrl(serverUrl),
    wsUrl: serverAddressToWsUrl(serverUrl),
    iceServers: iceServersFromServerAddress(serverUrl),
    roomId,
    roomKey,
  };
}

// 本地调试覆盖入口：开发者可在 localStorage.timenotes.iceServers 放额外 STUN/TURN 配置。
function storedIceServers(): RTCIceServer[] {
  const raw = window.localStorage.getItem('timenotes.iceServers');
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RTCIceServer[]) : [];
  } catch {
    return [];
  }
}

// 合并服务端 STUN 与本地覆盖配置，并按 urls/username/credential 去重。
function mergeIceServers(...groups: RTCIceServer[][]): RTCIceServer[] {
  const seen = new Set<string>();
  const merged: RTCIceServer[] = [];
  groups.flat().forEach((server) => {
    const urls = Array.isArray(server.urls) ? server.urls.filter(Boolean) : server.urls ? [server.urls] : [];
    if (!urls.length) {
      return;
    }
    const key = `${urls.join(',')}|${server.username ?? ''}|${String(server.credential ?? '')}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push({ ...server, urls: Array.isArray(server.urls) ? urls : urls[0] });
  });
  return merged;
}

// presence 通道可以丢包，文档、文件和聊天必须有序可靠。
function channelOptions(name: DataChannelName): RTCDataChannelInit {
  if (name === 'presence' || name === 'voice') {
    return { ordered: false, maxRetransmits: 0 };
  }
  return { ordered: true };
}

function withDefaultScheme(value: string, scheme: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${scheme}${value}`;
}

function formatRoomCreateNetworkError(serverUrl: string, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return [
    `无法访问协作服务：${serverUrl}`,
    '请确认 TimeNotesServer 已启动，并且左侧“服务器地址”填写的是当前客户端能访问的服务端地址。',
    '本机测试通常是 http://127.0.0.1:8787；跨设备测试不要填 127.0.0.1，要填服务端电脑的局域网 IP，并让服务端监听 0.0.0.0:8787。',
    `底层错误：${reason}`,
  ].join('\n');
}

function makeId(prefix: string) {
  if (crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function encodeFileTransferChunks(chunks: Array<string | Uint8Array | undefined>) {
  const presentChunks = chunks.filter((chunk): chunk is string | Uint8Array => chunk !== undefined);
  if (presentChunks.every((chunk): chunk is string => typeof chunk === 'string')) {
    return presentChunks.join('');
  }
  return bytesToBase64(concatUint8Arrays(presentChunks.map((chunk) => (typeof chunk === 'string' ? base64ToBytes(chunk) : chunk))));
}

// ===== 传入文件传输的信任边界 =====
// 对端资产声明不可信：以下常量与校验决定一个 transfer 是否被接受。

const maxIncomingTransferBytes = 256 * 1024 * 1024;
const maxIncomingSessionsPerPeer = 4;

// 各资源组允许的 MIME 前缀/精确值白名单；组外 MIME 直接拒绝。
const incomingMimeAllowlist: Record<string, string[]> = {
  assets: ['image/'],
  stickers: ['image/'],
  fonts: ['font/', 'application/font-', 'application/octet-stream'],
  audios: ['audio/', 'application/octet-stream'],
  videos: ['video/', 'application/octet-stream'],
  models: ['model/', 'application/octet-stream'],
};

function mimeAllowed(group: string, mimeType: string) {
  const allow = incomingMimeAllowlist[group];
  if (!allow) {
    return false;
  }
  const normalized = (mimeType || '').toLowerCase();
  return allow.some((prefix) => normalized.startsWith(prefix));
}

// 仅保留文件名部分：对端提供的 name/path 可能携带路径分隔符，落到 .tnote 打包或本地图径都有穿越风险。
function incomingFileBasename(value: string) {
  const parts = (value || '').split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1].slice(0, 128) : 'resource';
}

function isValidIncomingTransfer(start: FileResourceStartPayload) {
  if (!Number.isFinite(start.totalBytes) || start.totalBytes <= 0 || start.totalBytes > maxIncomingTransferBytes) {
    return false;
  }
  if (!Number.isFinite(start.totalChunks) || start.totalChunks <= 0 || start.totalChunks > 100000) {
    return false;
  }
  // 兼容旧版 16KB 与新版 64KB 分片的发送端；上限取两者较大值的 4 倍，超界视为异常声明。
  if (!Number.isFinite(start.chunkSize) || start.chunkSize <= 0 || start.chunkSize > 256 * 1024) {
    return false;
  }
  // 发送端按实际 dataBase64 长度切片，totalBytes 只是 asset.size 元数据（可能略有偏差），
  // 严格的分片数等式会在元数据陈旧时误拒整个传输；这里只挡数量级异常（声明尺寸连一片都装不下/超过上限）。
  if (start.totalChunks > Math.ceil((start.totalBytes + start.chunkSize) / start.chunkSize) + 1) {
    return false;
  }
  if (!mimeAllowed(start.group, start.asset?.mimeType ?? '')) {
    return false;
  }
  return true;
}

// 重组完成后重算 SHA-256 并与对端声明的 hash 比对，不匹配即丢弃。
// App 内存在两种合法 hash 口径：文件导入按原始字节（hashBlob），粘贴/裁剪按整个 dataURL
// 字符串（hashText）——匹配任一口径即视为完整，伪造者必须同时伪造两种原文，安全性等价。
// crypto.subtle 仅在 secure context 可用（Android WebView http 部署会缺失），此时退化为尺寸校验。
async function verifyIncomingTransferHash(start: FileResourceStartPayload, dataBase64: string) {
  const claimed = (start.asset?.hash ?? '').trim().toLowerCase();
  if (!claimed || !crypto?.subtle?.digest) {
    return true;
  }
  try {
    const bytes = base64ToBytes(dataBase64);
    const hexOf = async (input: ArrayBuffer | Uint8Array) => {
      const digest = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    if ((await hexOf(bytes)) === claimed) {
      return true;
    }
    // dataURL 口径：前缀来自对端声明的 mimeType，与发送端 hashText(dataUrl) 的原文一致。
    const dataUrl = `data:${start.asset?.mimeType || 'application/octet-stream'};base64,${dataBase64}`;
    return (await hexOf(new TextEncoder().encode(dataUrl))) === claimed;
  } catch {
    return false;
  }
}

// 对端 asset 元数据进入本地文档前清洗：只保留 basename，截断超长字段。
function sanitizeIncomingAsset(asset: AssetMeta): AssetMeta {
  return {
    ...asset,
    name: incomingFileBasename(asset.name ?? ''),
    path: incomingFileBasename(asset.path ?? ''),
    dataUrl: undefined,
    coverDataUrl: undefined,
    posterDataUrl: undefined,
  };
}


function concatUint8Arrays(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
}

import * as Y from 'yjs';
import { base64ByteLength, base64ToBytes, bytesToBase64 } from './base64';
import {
  announceCompletedResourceTransfer,
  announceResourceTransferProgress,
  announceResourceTransportReady,
  subscribeOutboundResourceTransfer,
  subscribeResourceTransferInvalidated,
  type OutboundResourceTransfer,
  type ResourceTransferInvalidation,
} from './resourceTransferBus';
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
const fileTransferChunkBytes = 16 * 1024;
const fileTransferChunkBase64Chars = Math.floor(fileTransferChunkBytes / 3) * 4;
const fileTransferChunkIntervalMs = 12;
const cursorPresenceFlushMs = 120;
const serverPresenceMinIntervalMs = 1000;
const latencyProbeIntervalMs = 3000;
const maxAutomaticSnapshotBytes = 2 * 1024 * 1024;
const maxDataChannelBufferedBytes = 8 * 1024 * 1024;
const maxFileChannelBufferedBytes = 2 * 1024 * 1024;
const maxRelaySocketBufferedBytes = 1024 * 1024;
const relaySocketBackpressureRetryMs = 40;

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
  private pendingDocTimer?: number;
  private pendingResourceTimer?: number;
  private pendingResourceArchiveTimer?: number;
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
    this.seenChats.add(message.id);
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
    const socket = new WebSocket(this.options.url);
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
    socket.addEventListener('message', (event) => this.handleEnvelope(JSON.parse(String(event.data)), 'relay'));
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
        this.applyFileResourceComplete(env.from ?? 'relay', env.payload as FileResourceCompletePayload);
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
    announceResourceTransportReady();
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
      const chunkBytes = base64ByteLength(chunkBase64);
      if (route === 'p2p') {
        await this.waitForFileBackpressure();
        if (!this.canUseP2PFileTransfer() || !this.canSendToAllPeers('file')) {
          // P2P 中途断开时重启为完整中转传输，避免对端拿到半份文件后一直停在临时控件。
          await this.sendFileTransfer(transfer, 'relay');
          return;
        }
        const chunk = base64ToBytes(chunkBase64);
        if (!this.sendBinaryToAllPeers('file', chunk)) {
          await this.sendFileTransfer(transfer, 'relay');
          return;
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
            chunkBytes,
            relay: true,
          } satisfies FileResourceChunkPayload),
        );
      }
      if (index < totalChunks - 1) {
        await sleep(fileTransferChunkIntervalMs);
      }
    }
    const completeEnv = this.makeEnvelope('file_resource_complete', { transferId, key: transfer.key, relay: route === 'relay' } satisfies FileResourceCompletePayload);
    if (route === 'p2p' && this.canUseP2PFileTransfer() && this.sendToAllPeers('file', completeEnv)) {
      return;
    } else {
      await this.waitForRelaySocketBackpressure();
      this.sendRelayEnvelope(completeEnv);
    }
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
    this.seenUpdates.add(updateId);
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
    this.seenUpdates.add(updateId);
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
    this.seenUpdates.add(payload.updateId);
    Y.applyUpdate(this.options.yDoc, base64ToBytes(payload.updateBase64), remoteOrigin);
  }

  private applyFileResourceStart(peerId: string, payload?: FileResourceStartPayload) {
    if (!payload?.transferId || !payload.key || peerId === this.options.user.id) {
      return;
    }
    if (this.availableFileTransferKeys.has(this.fileTransferDedupeKeyFromPayload(payload))) {
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
    const sessions = Array.from(this.incomingFileTransfers.values()).filter((session) => session.peerId === peerId);
    const session = sessions.find((item) => item.receivedChunks < item.start.totalChunks);
    if (!session) {
      return;
    }
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
    this.appendFileChunk(peerId, session.start.transferId, bytes);
  }

  private applyFileResourceComplete(peerId: string, payload?: FileResourceCompletePayload) {
    if (!payload?.transferId || peerId === this.options.user.id) {
      return;
    }
    const sessionKey = this.fileSessionKey(peerId, payload.transferId);
    const session = this.incomingFileTransfers.get(sessionKey);
    if (!session || session.receivedChunks < session.start.totalChunks) {
      return;
    }
    const dataBase64 = encodeFileTransferChunks(session.chunks);
    announceCompletedResourceTransfer({
      key: session.start.key,
      group: session.start.group,
      asset: session.start.asset,
      signature: session.start.signature,
      transferVersion: session.start.transferVersion,
      dataBase64,
    });
    this.availableFileTransferKeys.add(this.fileTransferDedupeKeyFromPayload(session.start));
    this.incomingFileTransfers.delete(sessionKey);
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
    announceResourceTransferProgress(this.fileProgress(session.start, session.receivedBytes, session.receivedChunks));
    if (session.receivedChunks >= session.start.totalChunks) {
      this.applyFileResourceComplete(peerId, { transferId, key: session.start.key });
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
  }

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
    this.seenChats.add(payload.messageId);
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
      announceResourceTransportReady();
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
    // iceServers 优先使用联机服务器返回的内置 STUN，再合并本地调试配置。
    const pc = new RTCPeerConnection({ iceServers: this.iceServers() });
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
        announceResourceTransportReady();
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
      this.handleEnvelope(JSON.parse(String(event.data)), 'p2p');
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
      await sleep(fileChannelBackpressureRetryMs);
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
  const roomKey = fragmentParams.get('roomKey') || link.searchParams.get('roomKey') || '';
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

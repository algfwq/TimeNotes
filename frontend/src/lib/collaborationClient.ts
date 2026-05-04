import * as Y from 'yjs';
import { base64ToBytes, bytesToBase64 } from './base64';
import type { ChatMessage, PresenceUser } from '../types';

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
}

export interface InviteInfo {
  serverUrl: string;
  wsUrl: string;
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
}

interface PeerConnection {
  id: string;
  user: PresenceUser;
  pc: RTCPeerConnection;
  channels: Partial<Record<'doc' | 'presence' | 'chat', RTCDataChannel>>;
  timer: number;
}

const remoteOrigin = 'timenotes-collaboration-remote';
const dataChannelNames = ['doc', 'presence', 'chat'] as const;
const collaborationDocumentKeyPrefix = 'document:';
const docUpdateFlushMs = 90;
const cursorPresenceFlushMs = 120;
const serverPresenceMinIntervalMs = 1000;
const latencyProbeIntervalMs = 3000;
const maxAutomaticSnapshotBytes = 2 * 1024 * 1024;

export class CollaborationClient {
  private options: CollaborationClientOptions;
  private socket?: WebSocket;
  private peers = new Map<string, PeerConnection>();
  private peerUsers = new Map<string, PresenceUser>();
  private seenUpdates = new Set<string>();
  private seenChats = new Set<string>();
  private readonly connectionId = makeId('conn');
  private updateSeq = 0;
  private snapshotCounter = 0;
  private connected = false;
  private presenceTimer?: number;
  private pendingPresenceTimer?: number;
  private latencyTimer?: number;
  private pendingDocTimer?: number;
  private pendingDocUpdates: Uint8Array[] = [];
  private pendingPings = new Map<string, number>();
  private nextLocalUpdateStateVector?: Uint8Array;
  private lastPresenceSentAt = 0;
  private lastServerPresenceAt = 0;
  private closing = false;
  private readonly onYUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(options: CollaborationClientOptions) {
    this.options = options;
    this.onYUpdate = (update, origin) => {
      if (origin === remoteOrigin || !this.connected) {
        return;
      }
      this.queueDocUpdate(update);
    };
    this.options.yDoc.on('update', this.onYUpdate);
    this.openSocket();
  }

  disconnect() {
    this.closing = true;
    this.connected = false;
    this.options.yDoc.off('update', this.onYUpdate);
    this.clearTimers();
    this.pendingDocUpdates = [];
    this.pendingPings.clear();
    this.peers.forEach((peer) => {
      window.clearTimeout(peer.timer);
      peer.pc.close();
    });
    this.peers.clear();
    this.peerUsers.clear();
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
    const payload = { messageId: message.id, text: trimmed, user: this.options.user, relay: this.needsRelay('chat') };
    const env = this.makeEnvelope('chat', payload);
    this.sendToPeers('chat', env);
    this.sendSocket(env);
  }

  kickPeer(clientId: string, reason = '房主已将你移出协作房间') {
    if (!clientId || !this.connected) {
      return;
    }
    this.sendSocket(this.makeEnvelope('peer_kick', { clientId, reason }));
  }

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
    this.publishPresence();
    this.startPresenceHeartbeat();
    this.startLatencyProbe();
    if (!hasStoredState) {
      this.sendFullStateUpdate();
      window.setTimeout(() => this.sendSnapshot(), 800);
    }
  }

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

  private queueDocUpdate(update: Uint8Array) {
    const outboundUpdate = this.nextLocalUpdateStateVector
      ? Y.encodeStateAsUpdate(this.options.yDoc, this.nextLocalUpdateStateVector)
      : update;
    this.nextLocalUpdateStateVector = undefined;
    this.pendingDocUpdates.push(outboundUpdate);
    if (this.pendingDocTimer) {
      return;
    }
    this.pendingDocTimer = window.setTimeout(() => {
      this.pendingDocTimer = undefined;
      const updates = this.pendingDocUpdates.splice(0);
      if (updates.length === 0 || !this.connected) {
        return;
      }
      this.broadcastDocUpdate(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
    }, docUpdateFlushMs);
  }

  private resetLocalCollaborationState() {
    this.options.yDoc.transact(() => {
      const snapshots = this.options.yDoc.getMap('snapshot');
      Array.from(snapshots.keys()).forEach((key) => {
        if (key === 'document' || key.startsWith(collaborationDocumentKeyPrefix)) {
          snapshots.delete(key);
        }
      });
      const resources = this.options.yDoc.getMap('resources');
      Array.from(resources.keys()).forEach((key) => resources.delete(key));
    }, remoteOrigin);
  }

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

  private broadcastDocUpdate(update: Uint8Array) {
    // 同一个浏览器标签会复用 sessionStorage 里的 user.id。
    // 协作者退出后重新加入时 updateSeq 会从 0 开始，如果 updateId 只用 user.id + seq，
    // 其他客户端会把新连接的编辑误判为旧连接已处理过的 update。connectionId 用于隔离每次连接生命周期。
    const updateId = `${this.options.user.id}:${this.connectionId}:${++this.updateSeq}`;
    this.seenUpdates.add(updateId);
    const payload: DocUpdatePayload = {
      updateId,
      updateBase64: bytesToBase64(update),
      // 文档 update 始终让服务端中转一份。资源拆分后普通编辑 update 通常只有几百字节，
      // 这比依赖 DataChannel 状态判断更稳，也不会再出现 35MB 素材包被反复中转的问题。
      relay: true,
    };
    const env = this.makeEnvelope('doc_update', payload);
    this.sendToPeers('doc', env);
    this.sendSocket(env);
    this.snapshotCounter += 1;
    if (this.snapshotCounter >= 50) {
      this.snapshotCounter = 0;
      this.sendSnapshot();
    }
  }

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

  private applyDocUpdate(payload?: DocUpdatePayload) {
    if (!payload?.updateBase64 || this.seenUpdates.has(payload.updateId)) {
      return;
    }
    this.seenUpdates.add(payload.updateId);
    Y.applyUpdate(this.options.yDoc, base64ToBytes(payload.updateBase64), remoteOrigin);
  }

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

  private publishPresence() {
    if (!this.connected) {
      return;
    }
    this.lastPresenceSentAt = performance.now();
    const transport: Transport = this.options.forceRelay ? 'relay' : this.hasAnyOpenChannel('presence') ? 'p2p' : 'relay';
    const user = { ...this.options.user, transport, lastSeen: new Date().toISOString() };
    this.options.user = user;
    const relay = this.needsRelay('presence');
    const env = this.makeEnvelope('presence', { user, relay });
    this.sendToPeers('presence', env);
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
    if (notify && isNewPeer) {
      this.options.onPeerJoined(peer);
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
    if (leavingUser) {
      this.options.onPeerLeft({ ...leavingUser, transport: 'offline' });
    }
  }

  private emitPeers() {
    this.options.onPeers(Array.from(this.peerUsers.values()));
  }

  private ensurePeer(user: PresenceUser) {
    if (this.options.forceRelay || this.peers.has(user.id)) {
      return;
    }
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
      const next = pc.connectionState === 'connected' ? 'p2p' : pc.connectionState === 'failed' || pc.connectionState === 'disconnected' ? 'relay' : undefined;
      if (next) {
        this.peerUsers.set(user.id, { ...(this.peerUsers.get(user.id) ?? user), transport: next });
        this.emitPeers();
      }
    };
    dataChannelNames.forEach((name) => {
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

  private attachChannel(peer: PeerConnection, channel: RTCDataChannel) {
    const label = dataChannelNames.includes(channel.label as any) ? (channel.label as keyof PeerConnection['channels']) : 'doc';
    peer.channels[label] = channel;
    channel.onopen = () => {
      this.peerUsers.set(peer.id, { ...(this.peerUsers.get(peer.id) ?? peer.user), transport: 'p2p' });
      this.emitPeers();
    };
    channel.onmessage = (event) => this.handleEnvelope(JSON.parse(String(event.data)), 'p2p');
  }

  private async createOffer(peer: PeerConnection) {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.sendSocket(this.makeEnvelope('signal', { kind: 'offer', sdp: offer.sdp }, peer.id));
  }

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

  private sendToPeers(channelName: 'doc' | 'presence' | 'chat', env: Envelope) {
    if (this.options.forceRelay) {
      return false;
    }
    let sent = false;
    this.peers.forEach((peer) => {
      const channel = peer.channels[channelName];
      if (channel?.readyState === 'open') {
        channel.send(JSON.stringify(env));
        sent = true;
      }
    });
    return sent;
  }

  private sendSocket(env: Envelope) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(env));
    }
  }

  private needsRelay(channelName: 'doc' | 'presence' | 'chat') {
    if (this.options.forceRelay) {
      return true;
    }
    const peerIDs = Array.from(this.peerUsers.keys());
    if (peerIDs.length === 0) {
      return false;
    }
    return peerIDs.some((peerID) => this.peers.get(peerID)?.channels[channelName]?.readyState !== 'open');
  }

  private hasAnyOpenChannel(channelName: 'doc' | 'presence' | 'chat') {
    return Array.from(this.peers.values()).some((peer) => peer.channels[channelName]?.readyState === 'open');
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

  private iceServers(): RTCIceServer[] {
    const raw = window.localStorage.getItem('timenotes.iceServers');
    if (!raw) {
      return [];
    }
    try {
      return JSON.parse(raw) as RTCIceServer[];
    } catch {
      return [];
    }
  }
}

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
    roomId,
    roomKey,
  };
}

function channelOptions(name: 'doc' | 'presence' | 'chat'): RTCDataChannelInit {
  if (name === 'presence') {
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

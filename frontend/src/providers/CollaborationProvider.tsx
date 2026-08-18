import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { Modal, Notification, Toast } from '@douyinfe/semi-ui';
import { CollaborationClient, parseInviteLink } from '../lib/collaborationClient';
import { isMobile } from '../lib/platform';
import { useDocument } from './DocumentProvider';
import type { ChatMessage, PresenceUser } from '../types';
import type { VoiceState } from '../lib/voiceClient';

interface ConnectOptions {
  url: string;
  roomId: string;
  roomKey: string;
  userName: string;
  forceRelay?: boolean;
  iceServers?: RTCIceServer[];
  /** 绑定到指定标签页；用于首页新建页后立刻联机，避免 React 状态尚未切换。 */
  tabId?: string;
  yDoc?: Y.Doc;
}

interface CursorPosition {
  pageId: string;
  x: number;
  y: number;
}

interface CollaborationContextValue {
  status: string;
  peers: PresenceUser[];
  messages: ChatMessage[];
  localUser: PresenceUser;
  latencyMs?: number;
  forceRelay: boolean;
  isConnected: boolean;
  isHost: boolean;
  canManagePages: boolean;
  connect: (options: ConnectOptions) => void;
  /** 解析邀请链接，新开空白编辑页并加入联机。 */
  joinInviteInNewDocument: (inviteLink: string, userName?: string) => void;
  disconnect: (reason?: DisconnectReason) => void;
  sendChat: (text: string) => void;
  kickPeer: (clientId: string) => void;
  updateCursor: (cursor?: CursorPosition | null) => void;
  setForceRelay: (forceRelay: boolean) => void;
  // 语音相关
  micEnabled: boolean;
  isSpeaking: boolean;
  speakingPeers: string[];
  startMic: () => Promise<void>;
  stopMic: () => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

type DisconnectReason = 'manual' | 'reconnect' | 'tab-change' | 'unmount' | 'room-closed';

const userColors = ['#2f6fed', '#2f8f68', '#c17817', '#c94d7b', '#5f5aa2'];
const sessionUserStorageKey = 'timenotes.sessionUserId';

// CollaborationProvider 是 UI 和 CollaborationClient 的边界：
// React 状态负责展示在线成员、聊天、延迟和本机身份，真正的网络连接只保存在 clientRef。
export function CollaborationProvider({ children }: { children: React.ReactNode }) {
  const { yDoc, activeTabId, activePageId, selectedElementId, editingElementId, openCollaborationGuestTab } = useDocument();
  const clientRef = useRef<CollaborationClient | null>(null);
  // 协作只绑定发起联机时的编辑标签页，切换到其他文档时主动断开，避免 Y.Doc 串到错误文件。
  const collaborationTabIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState('离线');
  const [peers, setPeers] = useState<PresenceUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | undefined>();
  const [forceRelay, setForceRelayState] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingPeers, setSpeakingPeers] = useState<string[]>([]);
  const [localUser, setLocalUser] = useState<PresenceUser>(() => ({
    id: getLocalUserId(),
    name: '本机',
    color: userColors[Math.floor(Math.random() * userColors.length)],
    pageId: activePageId,
    transport: 'offline',
  }));

  const disconnect = useCallback((reason: DisconnectReason = 'manual') => {
    // 断开时要同时清理底层 socket/peer、本地 UI 列表和 presence 身份，避免下次连接继承旧状态。
    const wasConnected = Boolean(clientRef.current);
    clientRef.current?.disconnect();
    clientRef.current = null;
    collaborationTabIdRef.current = null;
    setPeers([]);
    setMessages([]);
    setStatus('离线');
    setLatencyMs(undefined);
    setMicEnabled(false);
    setIsSpeaking(false);
    setSpeakingPeers([]);
    setLocalUser((current) => ({ ...current, role: undefined, transport: 'offline' }));
    if (wasConnected && reason !== 'reconnect' && reason !== 'unmount' && reason !== 'room-closed') {
      Toast.warning(reason === 'tab-change' ? '已退出当前协作：协作只作用于发起联机的标签页。' : '已退出当前协作');
    }
  }, []);

  const connect = useCallback(
    ({ url, roomId, roomKey, userName, forceRelay: nextForceRelay = forceRelay, iceServers, tabId, yDoc: yDocOverride }: ConnectOptions) => {
      // 新连接总是先关闭旧连接；同一页面重复点击“发起/加入”不会保留旧 peer 和计时器。
      disconnect('reconnect');
      // 生产构建连到非本机的明文 ws:// 时提示一次：房间密钥和文档内容会明文经过网络。
      if (import.meta.env.PROD) {
        try {
          const wsUrl = new URL(url);
          const host = wsUrl.hostname;
          const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
          if (wsUrl.protocol === 'ws:' && !isLoopback) {
            Toast.warning('当前使用未加密的 ws:// 连接，协作内容可能被同网络窃听；建议改用 wss:// 服务器');
          }
        } catch {
          // url 格式异常由后续连接流程报错，这里不重复处理。
        }
      }
      const boundTabId = tabId ?? activeTabId;
      const boundYDoc = yDocOverride ?? yDoc;
      const user = {
        ...localUser,
        name: userName || localUser.name || '本机',
        pageId: activePageId,
        selectedElementId: selectedElementId ?? null,
        editingElementId: editingElementId ?? null,
        transport: nextForceRelay ? 'relay' : 'p2p',
      } satisfies PresenceUser;
      setLocalUser(user);
      setMessages([]);
      setForceRelayState(nextForceRelay);
      collaborationTabIdRef.current = boundTabId;
      // 底层客户端直接持有当前活动标签页的 Y.Doc，后续文档 update 不再经过 React props 转发。
      clientRef.current = new CollaborationClient({
        url,
        roomId,
        roomKey,
        user,
        yDoc: boundYDoc,
        forceRelay: nextForceRelay,
        iceServers,
        onStatus: setStatus,
        onPeers: setPeers,
        onChat: (message) => setMessages((current) => [...current, message].slice(-200)),
        onLatency: setLatencyMs,
        onSelf: setLocalUser,
        onJoinPending: () => {
          setStatus('等待房主同意');
        },
        onJoinRequest: (request, respond) => {
          // 加入审批只在房主端弹出；审批结果通过 respond 写回 WebSocket 控制面。
          Modal.confirm({
            title: '协作者请求加入',
            content: `${request.user.name || '协作者'} 正在请求加入当前协作房间。连接 ID：${shortClientId(request.user.id)}`,
            okText: '同意加入',
            cancelText: '拒绝',
            onOk: () => respond(true),
            onCancel: () => respond(false, '房主已拒绝加入'),
          });
        },
        onJoinRejected: (reason) => {
          Notification.warning({
            title: '加入协作被拒绝',
            content: reason,
            duration: 5,
            position: 'topRight',
          });
          disconnect('room-closed');
        },
        onJoined: (user) => {
          if (user.role !== 'host') {
            Notification.success({
              title: '已成功加入协作房间',
              content: '现在可以开始实时协作。',
              duration: 4,
              position: 'topRight',
            });
          }
        },
        onPeerJoined: (user) => {
          Notification.info({
            title: `${user.name || '协作者'} 已加入协作`,
            content: '在线成员列表已更新。',
            duration: 4,
            position: 'topRight',
          });
        },
        onPeerLeft: (user) => {
          Notification.warning({
            title: `${user.name || '协作者'} 已退出协作`,
            content: '在线成员列表已更新。',
            duration: 4,
            position: 'topRight',
          });
        },
        onKicked: (reason) => {
          Notification.warning({
            title: '已被移出协作',
            content: reason,
            duration: 5,
            position: 'topRight',
          });
          disconnect('room-closed');
        },
        onRoomClosed: (message) => {
          Toast.warning(message);
          disconnect('room-closed');
        },
        onError: setStatus,
        onVoiceState: (state: VoiceState) => {
          setMicEnabled(state.micEnabled);
          setIsSpeaking(state.isSpeaking);
          setSpeakingPeers(state.speakingPeers);
        },
      });
    },
    [activePageId, activeTabId, disconnect, editingElementId, forceRelay, localUser, selectedElementId, yDoc],
  );

  const joinInviteInNewDocument = useCallback(
    (inviteLink: string, userName?: string) => {
      // 先解析邀请链接，避免无效链接时仍创建空白标签页。
      const parsed = parseInviteLink(inviteLink);
      const mobile = isMobile();
      const name = userName?.trim() || (mobile ? '手机用户' : '本机用户');
      const { tabId, yDoc: guestYDoc } = openCollaborationGuestTab('联机协作');
      connect({
        url: parsed.wsUrl,
        roomId: parsed.roomId,
        roomKey: parsed.roomKey,
        userName: name,
        // 移动端默认走应用层中转，与协作面板行为一致。
        forceRelay: mobile ? true : forceRelay,
        iceServers: parsed.iceServers,
        tabId,
        yDoc: guestYDoc,
      });
      Toast.success('正在加入邀请房间');
    },
    [connect, forceRelay, openCollaborationGuestTab],
  );

  const updateCursor = useCallback((cursor?: CursorPosition | null) => {
    // 光标属于 awareness/presence，不写入文档模型；本地状态仅用于即时隐藏和展示。
    const nextCursor = cursor ?? null;
    clientRef.current?.updateCursor(nextCursor);
    setLocalUser((current) => ({ ...current, cursor: nextCursor }));
  }, []);

  const sendChat = useCallback((text: string) => {
    clientRef.current?.sendChat(text);
  }, []);

  const kickPeer = useCallback((clientId: string) => {
    clientRef.current?.kickPeer(clientId);
  }, []);

  const setForceRelay = useCallback((nextForceRelay: boolean) => {
    // 强制中转只影响 TimeNotes 应用层传输路径，不会把服务器伪装成浏览器 ICE TURN。
    setForceRelayState(nextForceRelay);
    clientRef.current?.setForceRelay(nextForceRelay);
  }, []);

  const startMic = useCallback(async () => {
    await clientRef.current?.startMic();
    setMicEnabled(true);
  }, []);

  const stopMic = useCallback(() => {
    clientRef.current?.stopMic();
    setMicEnabled(false);
    setIsSpeaking(false);
    setSpeakingPeers([]);
  }, []);

  useEffect(() => {
    if (clientRef.current && collaborationTabIdRef.current !== activeTabId) {
      disconnect('tab-change');
      return;
    }
    // 页码、选中元素和正在编辑元素只作为 presence 广播，方便远端显示光标和选择框。
    const patch = { pageId: activePageId, selectedElementId: selectedElementId ?? null, editingElementId: editingElementId ?? null };
    setLocalUser((current) => ({ ...current, ...patch }));
    clientRef.current?.updateUser(patch);
  }, [activePageId, activeTabId, disconnect, editingElementId, selectedElementId]);

  useEffect(() => () => disconnect('unmount'), [disconnect]);

  const value = useMemo<CollaborationContextValue>(
    () => {
      const isConnected = status === '已连接' || status === 'connected';
      const isHost = !isConnected || localUser.role === 'host';
      return {
        status,
        peers,
        messages,
        localUser,
        latencyMs,
        forceRelay,
        isConnected,
        isHost,
        canManagePages: isHost,
        micEnabled,
        isSpeaking,
        speakingPeers,
        startMic,
        stopMic,
        connect,
        joinInviteInNewDocument,
        disconnect,
        sendChat,
        kickPeer,
        updateCursor,
        setForceRelay,
      };
    },
    [connect, disconnect, forceRelay, joinInviteInNewDocument, kickPeer, latencyMs, localUser, messages, peers, sendChat, setForceRelay, status, updateCursor, micEnabled, isSpeaking, speakingPeers, startMic, stopMic],
  );

  return <CollaborationContext.Provider value={value}>{children}</CollaborationContext.Provider>;
}

export function useCollaboration() {
  const context = useContext(CollaborationContext);
  if (!context) {
    throw new Error('useCollaboration must be used inside CollaborationProvider');
  }
  return context;
}

function getLocalUserId() {
  const existing = window.sessionStorage.getItem(sessionUserStorageKey);
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID ? `user-${crypto.randomUUID()}` : `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.sessionStorage.setItem(sessionUserStorageKey, next);
  return next;
}

function shortClientId(clientId: string) {
  return clientId.slice(-8) || clientId;
}

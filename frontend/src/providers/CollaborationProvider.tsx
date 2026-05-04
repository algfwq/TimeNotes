import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Notification, Toast } from '@douyinfe/semi-ui';
import { CollaborationClient } from '../lib/collaborationClient';
import { useDocument } from './DocumentProvider';
import type { ChatMessage, PresenceUser } from '../types';

interface ConnectOptions {
  url: string;
  roomId: string;
  roomKey: string;
  userName: string;
  forceRelay?: boolean;
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
  disconnect: (reason?: DisconnectReason) => void;
  sendChat: (text: string) => void;
  kickPeer: (clientId: string) => void;
  updateCursor: (cursor?: CursorPosition | null) => void;
  setForceRelay: (forceRelay: boolean) => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

type DisconnectReason = 'manual' | 'reconnect' | 'tab-change' | 'unmount' | 'room-closed';

const userColors = ['#2f6fed', '#2f8f68', '#c17817', '#c94d7b', '#5f5aa2'];
const sessionUserStorageKey = 'timenotes.sessionUserId';

export function CollaborationProvider({ children }: { children: React.ReactNode }) {
  const { yDoc, activeTabId, activePageId, selectedElementId, editingElementId } = useDocument();
  const clientRef = useRef<CollaborationClient | null>(null);
  const collaborationTabIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState('离线');
  const [peers, setPeers] = useState<PresenceUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | undefined>();
  const [forceRelay, setForceRelayState] = useState(false);
  const [localUser, setLocalUser] = useState<PresenceUser>(() => ({
    id: getLocalUserId(),
    name: '本机',
    color: userColors[Math.floor(Math.random() * userColors.length)],
    pageId: activePageId,
    transport: 'offline',
  }));

  const disconnect = useCallback((reason: DisconnectReason = 'manual') => {
    const wasConnected = Boolean(clientRef.current);
    clientRef.current?.disconnect();
    clientRef.current = null;
    collaborationTabIdRef.current = null;
    setPeers([]);
    setMessages([]);
    setStatus('离线');
    setLatencyMs(undefined);
    setLocalUser((current) => ({ ...current, role: undefined, transport: 'offline' }));
    if (wasConnected && reason !== 'reconnect' && reason !== 'unmount' && reason !== 'room-closed') {
      Toast.warning(reason === 'tab-change' ? '已退出当前协作：协作只作用于发起联机的标签页。' : '已退出当前协作');
    }
  }, []);

  const connect = useCallback(
    ({ url, roomId, roomKey, userName, forceRelay: nextForceRelay = forceRelay }: ConnectOptions) => {
      disconnect('reconnect');
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
      collaborationTabIdRef.current = activeTabId;
      clientRef.current = new CollaborationClient({
        url,
        roomId,
        roomKey,
        user,
        yDoc,
        forceRelay: nextForceRelay,
        onStatus: setStatus,
        onPeers: setPeers,
        onChat: (message) => setMessages((current) => [...current, message].slice(-200)),
        onLatency: setLatencyMs,
        onSelf: setLocalUser,
        onJoinPending: () => {
          setStatus('等待房主同意');
        },
        onJoinRequest: (request, respond) => {
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
      });
    },
    [activePageId, activeTabId, disconnect, editingElementId, forceRelay, localUser, selectedElementId, yDoc],
  );

  const updateCursor = useCallback((cursor?: CursorPosition | null) => {
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
    setForceRelayState(nextForceRelay);
    clientRef.current?.setForceRelay(nextForceRelay);
  }, []);

  useEffect(() => {
    if (clientRef.current && collaborationTabIdRef.current !== activeTabId) {
      disconnect('tab-change');
      return;
    }
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
        connect,
        disconnect,
        sendChat,
        kickPeer,
        updateCursor,
        setForceRelay,
      };
    },
    [connect, disconnect, forceRelay, kickPeer, latencyMs, localUser, messages, peers, sendChat, setForceRelay, status, updateCursor],
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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { useDocument } from './DocumentProvider';
import type { PresenceUser } from '../types';

interface ConnectOptions {
  url: string;
  roomId: string;
  roomKey: string;
  userName: string;
}

interface CollaborationContextValue {
  status: string;
  peers: PresenceUser[];
  isConnected: boolean;
  connect: (options: ConnectOptions) => void;
  disconnect: () => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

const userColors = ['#2f6fed', '#2f8f68', '#c17817', '#c94d7b', '#5f5aa2'];

export function CollaborationProvider({ children }: { children: React.ReactNode }) {
  const { yDoc, activePageId, selectedElementId } = useDocument();
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const [status, setStatus] = useState('离线');
  const [peers, setPeers] = useState<PresenceUser[]>([]);
  const localUserRef = useRef<PresenceUser>({
    name: '本机',
    color: userColors[Math.floor(Math.random() * userColors.length)],
    pageId: activePageId,
  });

  const refreshPeers = useCallback(() => {
    const awareness = providerRef.current?.awareness;
    if (!awareness) {
      setPeers([]);
      return;
    }
    const states = Array.from(awareness.getStates().values()) as Array<{ user?: PresenceUser }>;
    setPeers(states.map((state) => state.user).filter((user): user is PresenceUser => Boolean(user)));
  }, []);

  const disconnect = useCallback(() => {
    providerRef.current?.destroy();
    providerRef.current = null;
    setPeers([]);
    setStatus('离线');
  }, []);

  const connect = useCallback(
    ({ url, roomId, roomKey, userName }: ConnectOptions) => {
      disconnect();
      localUserRef.current = {
        ...localUserRef.current,
        name: userName || '本机',
        pageId: activePageId,
        selectedElementId,
      };
      const provider = new HocuspocusProvider({
        url,
        name: roomId,
        token: roomKey,
        document: yDoc,
        onStatus: ({ status: nextStatus }: { status: string }) => setStatus(nextStatus),
        onConnect: () => setStatus('已连接'),
        onDisconnect: () => setStatus('已断开'),
        onAuthenticationFailed: () => setStatus('密钥无效'),
        onAwarenessChange: refreshPeers,
      });
      provider.awareness?.setLocalStateField('user', localUserRef.current);
      providerRef.current = provider;
      setStatus('连接中');
    },
    [activePageId, disconnect, refreshPeers, selectedElementId, yDoc],
  );

  useEffect(() => {
    const awareness = providerRef.current?.awareness;
    if (!awareness) {
      return;
    }
    localUserRef.current = { ...localUserRef.current, pageId: activePageId, selectedElementId };
    awareness.setLocalStateField('user', localUserRef.current);
  }, [activePageId, selectedElementId]);

  useEffect(() => disconnect, [disconnect]);

  const value = useMemo<CollaborationContextValue>(
    () => ({
      status,
      peers,
      isConnected: status === '已连接' || status === 'connected',
      connect,
      disconnect,
    }),
    [connect, disconnect, peers, status],
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

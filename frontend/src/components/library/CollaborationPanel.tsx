import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Checkbox, Input, Modal, Space, Tag, TextArea, Toast, Typography } from '@douyinfe/semi-ui';
import { IconCloud, IconCopy, IconDelete, IconLink, IconUserGroup } from '@douyinfe/semi-icons';
import { createCollaborationRoom, iceServersFromServerAddress, normalizeHttpServerUrl, parseInviteLink, serverAddressToWsUrl } from '../../lib/collaborationClient';
import { copyTextToClipboard } from '../../lib/clipboard';
import { isMobile } from '../../lib/platform';
import { useCollaboration } from '../../providers/CollaborationProvider';
import type { PresenceUser } from '../../types';

/** 桌面本机默认；手机跨设备时 127.0.0.1 指向手机自身，必须填电脑局域网 IP 或用 adb reverse。 */
const DEFAULT_SERVER_DESKTOP = 'http://127.0.0.1:8787';
const DEFAULT_SERVER_MOBILE = '';

export function CollaborationPanel() {
  const { status, peers, isConnected, isHost, forceRelay, setForceRelay, connect, disconnect, kickPeer } = useCollaboration();
  const mobile = isMobile();
  const [serverAddress, setServerAddress] = useState(() => (isMobile() ? DEFAULT_SERVER_MOBILE : DEFAULT_SERVER_DESKTOP));
  const [roomId, setRoomId] = useState('');
  const [roomKey, setRoomKey] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [userName, setUserName] = useState(() => (isMobile() ? '手机用户' : '本机用户'));
  const [busy, setBusy] = useState(false);
  const [peerMenu, setPeerMenu] = useState<{ x: number; y: number; peer: PresenceUser } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // 移动端 WebRTC 打洞常因 NAT/防火墙失败；默认走应用层 WebSocket 中转，保证联机可用。
    // 桌面端仍默认尝试 P2P，用户可随时勾选「强制应用层中转」。
    if (mobile) {
      setForceRelay(true);
    }
  }, [mobile, setForceRelay]);

  useEffect(() => {
    try {
      const parsed = parseInviteLink(window.location.href);
      // App 可能直接被邀请链接唤起；启动后先把 fragment 里的房间信息回填到表单。
      setServerAddress(parsed.serverUrl);
      setRoomId(parsed.roomId);
      setRoomKey(parsed.roomKey);
      setInviteInput(window.location.href);
    } catch {
      // 当前页面不是邀请链接时保持默认输入。
    }
  }, []);

  useEffect(() => {
    const close = () => setPeerMenu(null);
    const clearLongPress = () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('pointerup', clearLongPress);
    window.addEventListener('pointercancel', clearLongPress);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('pointerup', clearLongPress);
      window.removeEventListener('pointercancel', clearLongPress);
      clearLongPress();
    };
  }, []);

  const openPeerMenu = (peer: PresenceUser, x: number, y: number) => {
    if (!isHost) {
      return;
    }
    setPeerMenu({ x, y, peer });
  };

  const startRoom = async () => {
    if (!serverAddress.trim()) {
      Toast.warning(mobile ? '请填写电脑局域网地址，例如 http://192.168.x.x:8787（勿用 127.0.0.1）' : '请填写协作服务器地址');
      return;
    }
    setBusy(true);
    try {
      // 创建房间时服务端会返回 wsUrl、inviteUrl 和内置 STUN；本地兜底再按地址推导一次 STUN。
      const created = await createCollaborationRoom(serverAddress, currentAppURL());
      setServerAddress(normalizeHttpServerUrl(serverAddress));
      setRoomId(created.roomId);
      setRoomKey(created.roomKey);
      setInviteUrl(created.inviteUrl);
      connect({ url: created.wsUrl, roomId: created.roomId, roomKey: created.roomKey, userName, forceRelay, iceServers: created.iceServers ?? iceServersFromServerAddress(serverAddress) });
      Toast.success('协作房间已创建');
    } catch (error) {
      Toast.error(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };

  const joinInvite = () => {
    try {
      // 邀请链接里的 roomKey 只在本地解析后用于 WebSocket auth，不会作为 HTTP 请求参数发送。
      const parsed = parseInviteLink(inviteInput);
      setServerAddress(parsed.serverUrl);
      setRoomId(parsed.roomId);
      setRoomKey(parsed.roomKey);
      connect({ url: parsed.wsUrl, roomId: parsed.roomId, roomKey: parsed.roomKey, userName, forceRelay, iceServers: parsed.iceServers });
      Toast.success('正在加入邀请房间');
    } catch (error) {
      Toast.error(String(error instanceof Error ? error.message : error));
    }
  };

  const connectCurrentRoom = () => {
    try {
      if (!serverAddress.trim() || !roomId.trim() || !roomKey.trim()) {
        Toast.warning('请填写服务器地址、房间 ID 和房间密钥');
        return;
      }
      // 手动加入房间时没有创建接口响应，因此从服务器地址推导 WebSocket 和 STUN。
      connect({ url: serverAddressToWsUrl(serverAddress), roomId, roomKey, userName, forceRelay, iceServers: iceServersFromServerAddress(serverAddress) });
    } catch (error) {
      Toast.error(String(error instanceof Error ? error.message : error));
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) {
      return;
    }
    const ok = await copyTextToClipboard(inviteUrl);
    if (ok) {
      Toast.success('邀请链接已复制');
    } else {
      Toast.warning('当前环境无法自动复制，请长按文本框手动复制邀请链接');
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4">
      <Space vertical align="start" spacing="medium" className="w-full">
        <div className="flex w-full items-center justify-between">
          <Typography.Text strong>协作房间</Typography.Text>
          <Space spacing={4}>
            {isConnected ? <Tag color={isHost ? 'blue' : 'orange'}>{isHost ? '房主' : '协作者'}</Tag> : null}
            <Tag color={isConnected ? 'green' : 'grey'}>{status}</Tag>
          </Space>
        </div>

        <label className="block w-full">
          <span className="mb-1 block text-xs text-black/45">服务器地址</span>
          <Input
            prefix={<IconCloud />}
            value={serverAddress}
            onChange={setServerAddress}
            placeholder={mobile ? 'http://电脑局域网IP:8787' : DEFAULT_SERVER_DESKTOP}
          />
          {mobile ? (
            <span className="mt-1 block text-xs text-black/40">
              手机上 127.0.0.1 是手机自己；请填电脑 WLAN IP，或用 adb reverse 后再填 http://127.0.0.1:8787
            </span>
          ) : null}
        </label>
        <label className="block w-full">
          <span className="mb-1 block text-xs text-black/45">你的显示名称</span>
          <Input prefix={<IconUserGroup />} value={userName} onChange={setUserName} />
        </label>
        <Checkbox checked={forceRelay} onChange={(event) => setForceRelay(Boolean(event.target.checked))}>
          {/* 这是 TimeNotes 自己的 WebSocket 数据中转，不是浏览器 ICE 的标准 TURN 服务。 */}
          强制应用层中转{mobile ? '（移动端默认开启）' : ''}
        </Checkbox>

        <div className="grid w-full grid-cols-2 gap-2">
          <Button theme="solid" type="primary" loading={busy} disabled={isConnected} onClick={startRoom}>
            发起联机
          </Button>
          <Button type={isConnected ? 'tertiary' : 'primary'} theme={isConnected ? 'solid' : 'light'} onClick={() => (isConnected ? disconnect() : connectCurrentRoom())}>
            {isConnected ? '断开协作' : '连接当前房间'}
          </Button>
        </div>

        <div className="w-full">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Typography.Text strong>邀请链接</Typography.Text>
            <Button size="small" icon={<IconCopy />} disabled={!inviteUrl} onClick={copyInvite}>
              复制
            </Button>
          </div>
          <TextArea
            autosize={{ minRows: 2, maxRows: 4 }}
            value={inviteUrl}
            onChange={setInviteUrl}
            placeholder="发起联机后这里会生成邀请链接"
          />
        </div>

        <div className="w-full">
          <div className="mb-2 flex items-center gap-2">
            <IconLink className="text-black/45" />
            <Typography.Text strong>加入邀请</Typography.Text>
          </div>
          <TextArea
            autosize={{ minRows: 2, maxRows: 4 }}
            value={inviteInput}
            onChange={setInviteInput}
            placeholder="粘贴协作者发来的邀请链接"
          />
          <Button className="mt-2" block theme="solid" type="primary" disabled={isConnected} onClick={joinInvite}>
            通过邀请链接加入
          </Button>
        </div>

        <div className="grid w-full grid-cols-1 gap-2">
          <Input prefix={<IconLink />} value={roomId} onChange={setRoomId} placeholder="房间 ID" />
          <Input mode="password" value={roomKey} onChange={setRoomKey} placeholder="房间密钥" />
        </div>
      </Space>

      <div className="mt-6">
        <Typography.Text strong>在线状态</Typography.Text>
        <div className="mt-3 space-y-2">
          {peers.length === 0 ? <div className="text-sm text-black/45">暂无其他在线成员</div> : null}
          {peers.map((peer) => (
            <div
              key={peer.id}
              className="flex items-center gap-2 rounded-[8px] bg-white px-3 py-2 touch-manipulation"
              style={{ cursor: isHost ? 'context-menu' : undefined }}
              onContextMenu={(event) => {
                if (!isHost) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                openPeerMenu(peer, event.clientX, event.clientY);
              }}
              onPointerDown={(event) => {
                // 触屏没有稳定右键；房主长按成员打开踢人菜单。
                if (!isHost || event.pointerType === 'mouse') {
                  return;
                }
                if (longPressTimerRef.current !== null) {
                  window.clearTimeout(longPressTimerRef.current);
                }
                const x = event.clientX;
                const y = event.clientY;
                longPressTimerRef.current = window.setTimeout(() => {
                  longPressTimerRef.current = null;
                  openPeerMenu(peer, x, y);
                }, 480);
              }}
            >
              <Avatar size="small" style={{ background: peer.color }}>
                {peer.name.slice(0, 1)}
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{peer.name}</div>
                <div className="text-xs text-black/45">
                  {peer.editingElementId ? '正在编辑元素' : peer.selectedElementId ? '已选中元素' : `页面 ${peer.pageId || '-'}`} · {peer.transport === 'p2p' ? 'P2P' : '中转'} · {shortPeerId(peer.id)}
                </div>
              </div>
              {isHost ? (
                <Button
                  size="small"
                  type="danger"
                  theme="borderless"
                  icon={<IconDelete />}
                  aria-label={`踢出 ${peer.name || '协作者'}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openPeerMenu(peer, event.clientX || 24, event.clientY || 24);
                  }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <PeerContextMenu
        state={peerMenu}
        onKick={(peer) => {
          // 踢出操作只允许房主通过成员右键菜单触发，最终由服务端校验房主身份。
          setPeerMenu(null);
          Modal.confirm({
            title: '踢出协作者',
            content: `确定将 ${peer.name || '协作者'}（${shortPeerId(peer.id)}）移出当前协作房间吗？`,
            okText: '踢出',
            cancelText: '取消',
            onOk: () => kickPeer(peer.id),
          });
        }}
      />
    </div>
  );
}

function currentAppURL() {
  // 桌面 WebView 下可能不是标准 http(s) 页面，邀请链接仍需要一个可落地的应用入口。
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:' || window.location.protocol === 'wails:') {
    return `${window.location.origin}${window.location.pathname}`;
  }
  return 'timenotes://collab';
}

function PeerContextMenu({ state, onKick }: { state: { x: number; y: number; peer: PresenceUser } | null; onKick: (peer: PresenceUser) => void }) {
  if (!state) {
    return null;
  }
  return (
    <div
      className="fixed z-[1000] min-w-44 rounded-[8px] border border-black/10 bg-white py-1 text-sm shadow-xl"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="border-b border-black/5 px-3 py-2">
        <div className="max-w-40 truncate font-medium">{state.peer.name || '协作者'}</div>
        <div className="text-xs text-black/45">连接 {shortPeerId(state.peer.id)}</div>
      </div>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-black/5" onClick={() => onKick(state.peer)}>
        <IconDelete />
        <span>踢出协作者</span>
      </button>
    </div>
  );
}

function shortPeerId(peerId: string) {
  return peerId.slice(-8) || peerId;
}

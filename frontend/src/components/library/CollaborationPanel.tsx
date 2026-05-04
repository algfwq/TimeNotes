import { useEffect, useState } from 'react';
import { Avatar, Button, Checkbox, Input, Space, Tag, TextArea, Toast, Typography } from '@douyinfe/semi-ui';
import { IconCloud, IconCopy, IconLink, IconUserGroup } from '@douyinfe/semi-icons';
import { createCollaborationRoom, normalizeHttpServerUrl, parseInviteLink, serverAddressToWsUrl } from '../../lib/collaborationClient';
import { useCollaboration } from '../../providers/CollaborationProvider';

export function CollaborationPanel() {
  const { status, peers, isConnected, isHost, forceRelay, setForceRelay, connect, disconnect } = useCollaboration();
  const [serverAddress, setServerAddress] = useState('http://127.0.0.1:8787');
  const [roomId, setRoomId] = useState('');
  const [roomKey, setRoomKey] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [userName, setUserName] = useState('本机用户');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const parsed = parseInviteLink(window.location.href);
      setServerAddress(parsed.serverUrl);
      setRoomId(parsed.roomId);
      setRoomKey(parsed.roomKey);
      setInviteInput(window.location.href);
    } catch {
      // 当前页面不是邀请链接时保持默认输入。
    }
  }, []);

  const startRoom = async () => {
    setBusy(true);
    try {
      const created = await createCollaborationRoom(serverAddress, currentAppURL());
      setServerAddress(normalizeHttpServerUrl(serverAddress));
      setRoomId(created.roomId);
      setRoomKey(created.roomKey);
      setInviteUrl(created.inviteUrl);
      connect({ url: created.wsUrl, roomId: created.roomId, roomKey: created.roomKey, userName, forceRelay });
      Toast.success('协作房间已创建');
    } catch (error) {
      Toast.error(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };

  const joinInvite = () => {
    try {
      const parsed = parseInviteLink(inviteInput);
      setServerAddress(parsed.serverUrl);
      setRoomId(parsed.roomId);
      setRoomKey(parsed.roomKey);
      connect({ url: parsed.wsUrl, roomId: parsed.roomId, roomKey: parsed.roomKey, userName, forceRelay });
      Toast.success('正在加入邀请房间');
    } catch (error) {
      Toast.error(String(error instanceof Error ? error.message : error));
    }
  };

  const connectCurrentRoom = () => {
    try {
      connect({ url: serverAddressToWsUrl(serverAddress), roomId, roomKey, userName, forceRelay });
    } catch (error) {
      Toast.error(String(error instanceof Error ? error.message : error));
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      Toast.success('邀请链接已复制');
    } catch {
      Toast.warning('当前环境无法自动复制，请手动复制邀请链接');
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4">
      <Space vertical align="start" spacing="medium" className="w-full">
        <div className="flex w-full items-center justify-between">
          <Typography.Text strong>协同房间</Typography.Text>
          <Space spacing={4}>
            {isConnected ? <Tag color={isHost ? 'blue' : 'orange'}>{isHost ? '房主' : '协作者'}</Tag> : null}
            <Tag color={isConnected ? 'green' : 'grey'}>{status}</Tag>
          </Space>
        </div>

        <label className="block w-full">
          <span className="mb-1 block text-xs text-black/45">服务器地址</span>
          <Input prefix={<IconCloud />} value={serverAddress} onChange={setServerAddress} placeholder="http://127.0.0.1:8787" />
        </label>
        <label className="block w-full">
          <span className="mb-1 block text-xs text-black/45">你的显示名称</span>
          <Input prefix={<IconUserGroup />} value={userName} onChange={setUserName} />
        </label>
        <Checkbox checked={forceRelay} onChange={(event) => setForceRelay(Boolean(event.target.checked))}>
          强制服务器中转
        </Checkbox>

        <div className="grid w-full grid-cols-2 gap-2">
          <Button theme="solid" type="primary" loading={busy} disabled={isConnected} onClick={startRoom}>
            发起联机
          </Button>
          <Button type={isConnected ? 'tertiary' : 'primary'} theme={isConnected ? 'solid' : 'light'} onClick={() => (isConnected ? disconnect() : connectCurrentRoom())}>
            {isConnected ? '断开协同' : '连接当前房间'}
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
            <div key={peer.id} className="flex items-center gap-2 rounded-[8px] bg-white px-3 py-2">
              <Avatar size="small" style={{ background: peer.color }}>
                {peer.name.slice(0, 1)}
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm">{peer.name}</div>
                <div className="text-xs text-black/45">
                  {peer.editingElementId ? '正在编辑元素' : peer.selectedElementId ? '已选中元素' : `页面 ${peer.pageId || '-'}`} · {peer.transport === 'p2p' ? 'P2P' : '中转'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function currentAppURL() {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:' || window.location.protocol === 'wails:') {
    return `${window.location.origin}${window.location.pathname}`;
  }
  return 'timenotes://collab';
}

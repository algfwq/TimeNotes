import { useState } from 'react';
import { Avatar, Button, Input, Space, Tag, Typography } from '@douyinfe/semi-ui';
import { IconCloud, IconLink, IconUserGroup } from '@douyinfe/semi-icons';
import { useCollaboration } from '../../providers/CollaborationProvider';

export function CollaborationPanel() {
  const { status, peers, isConnected, connect, disconnect } = useCollaboration();
  const [url, setUrl] = useState('ws://127.0.0.1:1234');
  const [roomId, setRoomId] = useState('timenotes-demo');
  const [roomKey, setRoomKey] = useState('local-room-key');
  const [userName, setUserName] = useState('本机用户');

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4">
      <Space vertical align="start" spacing="medium" className="w-full">
        <div className="flex w-full items-center justify-between">
          <Typography.Text strong>协同房间</Typography.Text>
          <Tag color={isConnected ? 'green' : 'grey'}>{status}</Tag>
        </div>
        <Input prefix={<IconCloud />} value={url} onChange={setUrl} />
        <Input prefix={<IconLink />} value={roomId} onChange={setRoomId} />
        <Input mode="password" value={roomKey} onChange={setRoomKey} />
        <Input prefix={<IconUserGroup />} value={userName} onChange={setUserName} />
        <Button
          block
          theme="solid"
          type={isConnected ? 'tertiary' : 'primary'}
          onClick={() => (isConnected ? disconnect() : connect({ url, roomId, roomKey, userName }))}
        >
          {isConnected ? '断开协同' : '连接房间'}
        </Button>
      </Space>

      <div className="mt-6">
        <Typography.Text strong>在线状态</Typography.Text>
        <div className="mt-3 space-y-2">
          {peers.length === 0 ? <div className="text-sm text-black/45">暂无其他在线成员</div> : null}
          {peers.map((peer, index) => (
            <div key={`${peer.name}-${index}`} className="flex items-center gap-2 rounded-[8px] bg-white px-3 py-2">
              <Avatar size="small" style={{ background: peer.color }}>
                {peer.name.slice(0, 1)}
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm">{peer.name}</div>
                <div className="text-xs text-black/45">{peer.selectedElementId ? '正在编辑元素' : '正在浏览画布'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

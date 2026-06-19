import { Slider, Tag, Button } from '@douyinfe/semi-ui';
import { IconMicrophone, IconMicrophoneOff } from '@douyinfe/semi-icons';
import { useCollaboration } from '../providers/CollaborationProvider';
import { useDocument } from '../providers/DocumentProvider';
import type { ToolMode } from '../types';

const toolLabels: Record<ToolMode, string> = {
  select: '选择',
  pan: '移动画布',
  text: '文本',
  code: '代码块',
  image: '图片',
  sticker: '贴纸',
  audio: '音频',
  video: '视频',
  model: '3D 模型',
  tape: '胶带笔',
  drawing: '画笔',
};

export function StatusBar() {
  const { document, selectedElementId, zoom, setZoom, tool, activePage } = useDocument();
  const { status, peers, latencyMs, isConnected, micEnabled, isSpeaking, speakingPeers, startMic, stopMic } = useCollaboration();
  const transport = !isConnected ? '离线' : peers.length === 0 ? '等待成员' : peers.some((peer) => peer.transport === 'p2p') ? 'P2P' : '中转';
  const latencyLabel = latencyMs === undefined ? '-- ms' : `${latencyMs} ms`;
  const latencyColor = latencyMs === undefined ? 'grey' : latencyMs < 80 ? 'green' : latencyMs < 180 ? 'orange' : 'red';

  const handleToggleMic = () => {
    if (micEnabled) {
      stopMic();
    } else {
      void startMic();
    }
  };

  return (
    <div className="flex h-12 min-w-0 items-center justify-between gap-3 overflow-hidden px-4 text-xs text-black/58">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <span>{activePage.title}</span>
        <span>{document.elements.filter((element) => element.pageId === activePage.id).length} 个元素</span>
        <span className="truncate">{selectedElementId ? `选中 ${selectedElementId}` : '未选择元素'}</span>
        <span>工具 {toolLabels[tool]}</span>
        <Tag size="small" color={status === '已连接' ? 'green' : 'grey'}>
          联机 {status}
        </Tag>
        <Tag size="small" color={transport === 'P2P' ? 'green' : transport === '中转' ? 'orange' : 'grey'}>
          {transport}
        </Tag>
        <Tag size="small" color={latencyColor}>
          延迟 {latencyLabel}
        </Tag>
        <span>{peers.length} 位协作者</span>
        {isConnected && (
          <>
            <Button
              size="small"
              theme="borderless"
              type={micEnabled ? 'primary' : 'tertiary'}
              icon={micEnabled ? <IconMicrophone /> : <IconMicrophoneOff />}
              onClick={handleToggleMic}
              title={micEnabled ? '关闭麦克风' : '打开麦克风'}
            />
            {speakingPeers.map((peerId) => {
              const peer = peers.find((p) => p.id === peerId);
              return (
                <Tag key={peerId} size="small" color="blue">
                  {peer?.name || peerId.slice(-8)} 正在说话
                </Tag>
              );
            })}
            {isSpeaking && (
              <Tag size="small" color="blue">
                你正在说话
              </Tag>
            )}
          </>
        )}
      </div>
      <div className="flex w-64 shrink-0 items-center gap-3">
        <span className="shrink-0">缩放 {Math.round(zoom * 100)}%</span>
        <Slider value={zoom * 100} min={35} max={200} step={5} onChange={(value) => setZoom(Number(value) / 100)} />
      </div>
    </div>
  );
}

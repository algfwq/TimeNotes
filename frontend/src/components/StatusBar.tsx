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

export function StatusBar({ compactChrome = false }: { compactChrome?: boolean }) {
  const { document, selectedElementId, zoom, setZoom, tool, activePage, autoSaveState } = useDocument();
  const { status, peers, latencyMs, isConnected, micEnabled, isSpeaking, speakingPeers, startMic, stopMic } = useCollaboration();
  const transport = !isConnected ? '离线' : peers.length === 0 ? '等待成员' : peers.some((peer) => peer.transport === 'p2p') ? 'P2P' : '中转';
  const latencyLabel = latencyMs === undefined ? '-- ms' : `${latencyMs} ms`;
  const latencyColor = latencyMs === undefined ? 'grey' : latencyMs < 80 ? 'green' : latencyMs < 180 ? 'orange' : 'red';
  const safeZoom = Number.isFinite(zoom) ? Math.min(2, Math.max(0.35, zoom)) : 0.82;
  const elementCount = document.elements.filter((element) => element.pageId === activePage.id).length;

  const handleToggleMic = () => {
    if (micEnabled) {
      stopMic();
    } else {
      void startMic();
    }
  };

  return (
    <div className={`timenotes-statusbar flex min-w-0 items-center justify-between overflow-hidden text-xs text-black/58 ${compactChrome ? 'h-10 gap-2 px-2' : 'h-12 gap-3 px-4'}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {autoSaveState !== 'idle' ? (
          <Tag size="small" color={autoSaveState === 'saving' ? 'blue' : autoSaveState === 'saved' ? 'green' : 'red'}>
            {autoSaveState === 'saving' ? (compactChrome ? '保存中' : '自动保存中...') : autoSaveState === 'saved' ? (compactChrome ? '已保存' : '已自动保存') : '保存失败'}
          </Tag>
        ) : null}
        <span className="shrink-0 truncate">{activePage.title}</span>
        <span className="shrink-0">{compactChrome ? `${elementCount}元素` : `${elementCount} 个元素`}</span>
        {!compactChrome ? (
          <span className="truncate">{selectedElementId ? `选中 ${selectedElementId}` : '未选择元素'}</span>
        ) : null}
        <span className="shrink-0 truncate">{compactChrome ? toolLabels[tool] : `工具 ${toolLabels[tool]}`}</span>
        <Tag size="small" color={status === '已连接' ? 'green' : 'grey'}>
          {compactChrome ? status : `联机 ${status}`}
        </Tag>
        {!compactChrome || isConnected ? (
          <Tag size="small" color={transport === 'P2P' ? 'green' : transport === '中转' ? 'orange' : 'grey'}>
            {transport}
          </Tag>
        ) : null}
        {!compactChrome || isConnected ? (
          <Tag size="small" color={latencyColor}>
            {compactChrome ? latencyLabel : `延迟 ${latencyLabel}`}
          </Tag>
        ) : null}
        {!compactChrome ? <span>{peers.length} 位协作者</span> : isConnected ? <span className="shrink-0">{peers.length}人</span> : null}
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
            {!compactChrome
              ? speakingPeers.map((peerId) => {
                  const peer = peers.find((p) => p.id === peerId);
                  return (
                    <Tag key={peerId} size="small" color="blue">
                      {peer?.name || peerId.slice(-8)} 正在说话
                    </Tag>
                  );
                })
              : null}
            {!compactChrome && isSpeaking ? (
              <Tag size="small" color="blue">
                你正在说话
              </Tag>
            ) : null}
          </>
        )}
      </div>
      <div className={`flex shrink-0 items-center gap-2 ${compactChrome ? 'w-36' : 'w-64 gap-3'}`}>
        <span className="shrink-0">{compactChrome ? `${Math.round(safeZoom * 100)}%` : `缩放 ${Math.round(safeZoom * 100)}%`}</span>
        <Slider
          value={safeZoom * 100}
          min={35}
          max={200}
          step={5}
          tipFormatter={(value) => `${Math.round(Number(value) || safeZoom * 100)}%`}
          onChange={(value) => {
            const next = Array.isArray(value) ? Number(value[0]) : Number(value);
            if (!Number.isFinite(next)) {
              return;
            }
            setZoom(Math.min(2, Math.max(0.35, next / 100)));
          }}
        />
      </div>
    </div>
  );
}

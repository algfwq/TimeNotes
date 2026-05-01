import { Slider, Tag } from '@douyinfe/semi-ui';
import { useCollaboration } from '../providers/CollaborationProvider';
import { useDocument } from '../providers/DocumentProvider';
import type { ToolMode } from '../types';

const toolLabels: Record<ToolMode, string> = {
  select: '选择',
  pan: '移动画布',
  text: '文本',
  image: '图片',
  sticker: '贴纸',
  tape: '胶带笔',
  shape: '形状',
  drawing: '画笔',
};

export function StatusBar() {
  const { document, selectedElementId, zoom, setZoom, tool, activePage } = useDocument();
  const { status, peers } = useCollaboration();
  return (
    <div className="flex h-12 min-w-0 items-center justify-between gap-3 overflow-hidden px-4 text-xs text-black/58">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <span>{activePage.title}</span>
        <span>{document.elements.filter((element) => element.pageId === activePage.id).length} 个元素</span>
        <span className="truncate">{selectedElementId ? `选中 ${selectedElementId}` : '未选择元素'}</span>
        <span>工具 {toolLabels[tool]}</span>
        <Tag size="small" color={status === '已连接' ? 'green' : 'grey'}>
          协同 {status}
        </Tag>
        <span>{peers.length} 个在线状态</span>
      </div>
      <div className="flex w-64 shrink-0 items-center gap-3">
        <span className="shrink-0">缩放 {Math.round(zoom * 100)}%</span>
        <Slider value={zoom * 100} min={35} max={200} step={5} onChange={(value) => setZoom(Number(value) / 100)} />
      </div>
    </div>
  );
}

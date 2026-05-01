import { useEffect, useMemo, useState } from 'react';
import { Button, ColorPicker, Empty, Input, Modal, Select, Space, Tabs, Toast, Tooltip, Typography, Upload } from '@douyinfe/semi-ui';
import {
  IconArrowDown,
  IconArrowUp,
  IconColorPalette,
  IconCopy,
  IconCrop,
  IconDelete,
  IconEdit,
  IconFont,
  IconImage,
  IconLayers,
  IconText,
  IconUpload,
} from '@douyinfe/semi-icons';
import { AssetService } from '../../bindings/changeme';
import { builtinStickers } from '../data/builtinStickers';
import { createAssetFromDataUrl, createAssetFromFile, createAssetFromUrl } from '../lib/files';
import { fontDisplayName, fontFamilyForAsset } from '../lib/fonts';
import { useDocument } from '../providers/DocumentProvider';
import type { AssetMeta, ElementType, NoteElement, NotePage, SystemFont, ToolMode, ToolStyleState } from '../types';
import { ImageCropModal } from './ImageCropModal';

const pageSwatches = ['#fffaf0', '#ffffff', '#f7f0df', '#f2f5ff', '#eef8f1', '#fff1f3', '#202124'];
const backgroundSwatches = ['', '#ffffff', '#fff3b8', '#f3d6e7', '#d8eef0', '#e9f1d8', '#f8d3c4'];
const textSwatches = ['#2f2a24', '#0f4c81', '#3d6b59', '#8a3f58', '#6b4b9b', '#ffffff'];
const brushSwatches = ['#446f64', '#2f2a24', '#0f4c81', '#8a3f58', '#6b4b9b', '#f2cf72'];
const tapeSwatches = ['#f2cf72', '#f8a7b8', '#a9d8c6', '#9dc3ea', '#d5c2f0', '#f7b267'];

export function InspectorPanel() {
  const {
    document,
    activePage,
    activePageId,
    selectedElement,
    selectedElementId,
    tool,
    toolStyles,
    selectElement,
    updateElement,
    deleteElement,
    duplicateElement,
    renameElement,
    moveElementLayer,
    updatePage,
    startEditing,
    addElement,
    addAsset,
    replaceAsset,
    addSticker,
    replaceSticker,
    deleteSticker,
    addFont,
    updateToolStyle,
  } = useDocument();
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [cropElementId, setCropElementId] = useState<string | null>(null);
  const elements = useMemo(
    () =>
      document.elements
        .filter((element) => element.pageId === activePageId)
        .slice()
        .sort((first, second) => second.zIndex - first.zIndex),
    [activePageId, document.elements],
  );
  const elementAssets = useMemo(() => [...document.assets, ...document.stickers], [document.assets, document.stickers]);

  const importSystemFont = async (font: SystemFont) => {
    try {
      const imported = (await (AssetService as any).ImportFonts([font.path])) as AssetMeta[];
      const asset = imported[0];
      if (!asset) {
        Toast.error('字体导入失败');
        return '';
      }
      addFont(asset);
      return fontFamilyForAsset(asset);
    } catch (error) {
      Toast.error(`字体导入失败：${String(error)}`);
      return '';
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        className="timenotes-right-tabs flex h-full min-h-0 flex-col"
        defaultActiveKey="layers"
        tabPaneMotion={false}
        tabBarStyle={{ padding: '0 16px', margin: 0 }}
      >
        <Tabs.TabPane tab="图层" itemKey="layers" className="min-h-0 flex-1 overflow-hidden">
          <LayerPanel
            page={activePage}
            assets={document.assets}
            elementAssets={elementAssets}
            selectedElementId={selectedElementId}
            elements={elements}
            onAddAsset={addAsset}
            onPatchPage={(patch) => updatePage(activePage.id, patch)}
            onSelect={selectElement}
            onRename={(element) => setRenameTarget({ id: element.id, title: layerTitle(element, elementAssets) })}
            onMove={moveElementLayer}
            onDuplicate={duplicateElement}
            onDelete={deleteElement}
          />
        </Tabs.TabPane>
        <Tabs.TabPane tab="控制" itemKey="controls" className="min-h-0 flex-1 overflow-hidden">
          <ControlsPanel
            tool={tool}
            toolStyles={toolStyles}
            selectedElement={selectedElement}
            assets={document.assets}
            stickers={document.stickers}
            fonts={document.fonts}
            onPatchElement={(patch) => selectedElement && updateElement(selectedElement.id, patch)}
            onEditText={() => selectedElement && startEditing(selectedElement.id)}
            onCropElement={(id) => setCropElementId(id)}
            onAddElement={addElement}
            onUpdateToolStyle={updateToolStyle}
            onAddFont={addFont}
            onAddAsset={addAsset}
            onReplaceAsset={replaceAsset}
            onAddSticker={addSticker}
            onReplaceSticker={replaceSticker}
            onDeleteSticker={deleteSticker}
            onUseSystemFont={importSystemFont}
          />
        </Tabs.TabPane>
      </Tabs>

      <Modal
        title="重命名图层"
        visible={Boolean(renameTarget)}
        okText="确认"
        cancelText="取消"
        onCancel={() => setRenameTarget(null)}
        onOk={() => {
          if (renameTarget) {
            renameElement(renameTarget.id, renameTarget.title);
          }
          setRenameTarget(null);
        }}
      >
        <Input value={renameTarget?.title ?? ''} onChange={(title) => setRenameTarget((current) => (current ? { ...current, title } : current))} />
      </Modal>
      <InspectorCropModal elementId={cropElementId} onClose={() => setCropElementId(null)} />
    </div>
  );
}

function LayerPanel({
  page,
  assets,
  elementAssets,
  selectedElementId,
  elements,
  onAddAsset,
  onPatchPage,
  onSelect,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
}: {
  page: NotePage;
  assets: AssetMeta[];
  elementAssets: AssetMeta[];
  selectedElementId?: string;
  elements: NoteElement[];
  onAddAsset: (asset: AssetMeta) => void;
  onPatchPage: (patch: Partial<NotePage>) => void;
  onSelect: (id?: string) => void;
  onRename: (element: NoteElement) => void;
  onMove: (id: string, direction: 'up' | 'down' | 'front' | 'back') => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col px-4 py-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Typography.Title heading={6} style={{ margin: 0 }}>
            图层
          </Typography.Title>
          <div className="text-xs text-black/45">可视化选择、排序、重命名和删除元素</div>
        </div>
        <IconLayers className="text-black/35" />
      </div>
      <PageStylePanel page={page} assets={assets} onAddAsset={onAddAsset} onPatch={onPatchPage} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
        {elements.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-black/15 bg-white/60 px-4 py-8 text-center text-sm text-black/45">
            当前页面还没有元素
          </div>
        ) : null}
        <div className="space-y-2">
          {elements.map((element) => {
            const selected = element.id === selectedElementId;
            return (
              <div
                key={element.id}
                role="button"
                tabIndex={0}
                className={`flex w-full items-center gap-3 rounded-[8px] border px-2 py-2 text-left transition ${
                  selected ? 'border-[#2f6fed] bg-white shadow-sm' : 'border-transparent bg-white/55 hover:bg-white'
                }`}
                onClick={() => onSelect(element.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    onSelect(element.id);
                  }
                }}
              >
                <LayerPreview element={element} assets={elementAssets} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{layerTitle(element, elementAssets)}</div>
                  <div className="text-xs text-black/45">z {element.zIndex}</div>
                </div>
                <Space spacing={1}>
                  <LayerIconButton label="重命名" icon={<IconEdit />} onClick={() => onRename(element)} />
                  <LayerIconButton label="上移一层" icon={<IconArrowUp />} onClick={() => onMove(element.id, 'up')} />
                  <LayerIconButton label="下移一层" icon={<IconArrowDown />} onClick={() => onMove(element.id, 'down')} />
                  <LayerIconButton label="复制" icon={<IconCopy />} onClick={() => onDuplicate(element.id)} />
                  <LayerIconButton danger label="删除" icon={<IconDelete />} onClick={() => onDelete(element.id)} />
                </Space>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LayerIconButton({ label, icon, danger, onClick }: { label: string; icon: React.ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button
        size="small"
        type={danger ? 'danger' : 'primary'}
        theme="borderless"
        icon={icon}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      />
    </Tooltip>
  );
}

function PageStylePanel({
  page,
  assets,
  onAddAsset,
  onPatch,
}: {
  page: NotePage;
  assets: AssetMeta[];
  onAddAsset: (asset: AssetMeta) => void;
  onPatch: (patch: Partial<NotePage>) => void;
}) {
  const [cropVisible, setCropVisible] = useState(false);
  const [pendingAsset, setPendingAsset] = useState<AssetMeta | null>(null);
  const backgroundAsset = pendingAsset?.id === page.backgroundAssetId ? pendingAsset : assets.find((asset) => asset.id === page.backgroundAssetId);
  const backgroundSrc = backgroundAsset?.dataUrl ?? (backgroundAsset?.dataBase64 ? `data:${backgroundAsset.mimeType};base64,${backgroundAsset.dataBase64}` : undefined);

  const importBackground = async (file: File) => {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
      return;
    }
    const asset = await createAssetFromFile(file, 'assets');
    onAddAsset(asset);
    setPendingAsset(asset);
    onPatch({
      backgroundAssetId: asset.id,
      backgroundFit: 'cover',
      backgroundCropX: 50,
      backgroundCropY: 50,
    });
    setCropVisible(true);
  };

  const applyBackgroundCrop = async (dataUrl: string) => {
    const asset = await createAssetFromDataUrl(dataUrl, `${backgroundAsset?.name ?? '画布背景'}-裁剪.png`, 'assets', 'image/png');
    onAddAsset(asset);
    onPatch({ backgroundAssetId: asset.id, backgroundFit: 'cover', backgroundCropX: 50, backgroundCropY: 50 });
    setCropVisible(false);
    setPendingAsset(null);
  };

  return (
    <div className="mb-4 rounded-[8px] border border-black/10 bg-white/70 p-3">
      <div className="mb-3 flex items-center gap-2">
        <IconColorPalette />
        <Typography.Text strong>画布背景</Typography.Text>
      </div>
      <Swatches label="页面颜色" value={page.background} values={pageSwatches} onChange={(background) => onPatch({ background })} />
      {backgroundSrc ? (
        <div className="mb-3 overflow-hidden rounded-[8px] border border-black/10 bg-white">
          <img className="h-28 w-full object-cover" src={backgroundSrc} alt="" draggable={false} />
          <div className="truncate px-2 py-1 text-xs text-black/50">{backgroundAsset?.name}</div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Upload
          action=""
          accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
          showUploadList={false}
          uploadTrigger="custom"
          onFileChange={(files: File[]) => {
            files.slice(0, 1).forEach((file) => void importBackground(file));
          }}
        >
          <Button size="small" icon={<IconUpload />}>
            上传背景图
          </Button>
        </Upload>
        <Button size="small" icon={<IconCrop />} disabled={!backgroundSrc} onClick={() => setCropVisible(true)}>
          裁剪背景
        </Button>
        {backgroundSrc ? (
          <Button
            size="small"
            type="danger"
            theme="borderless"
            onClick={() => onPatch({ backgroundAssetId: '', backgroundFit: 'cover', backgroundCropX: 50, backgroundCropY: 50 })}
          >
            移除图片
          </Button>
        ) : null}
      </div>
      <ImageCropModal
        title="裁剪画布背景"
        visible={cropVisible}
        src={backgroundSrc}
        aspectRatio={page.width / Math.max(1, page.height)}
        onClose={() => {
          setCropVisible(false);
          setPendingAsset(null);
        }}
        onApply={applyBackgroundCrop}
      />
    </div>
  );
}

function ControlsPanel({
  tool,
  toolStyles,
  selectedElement,
  assets,
  stickers,
  fonts,
  onPatchElement,
  onEditText,
  onCropElement,
  onAddElement,
  onUpdateToolStyle,
  onAddAsset,
  onReplaceAsset,
  onAddSticker,
  onReplaceSticker,
  onDeleteSticker,
  onAddFont,
  onUseSystemFont,
}: {
  tool: ToolMode;
  toolStyles: ToolStyleState;
  selectedElement?: NoteElement;
  assets: AssetMeta[];
  stickers: AssetMeta[];
  fonts: AssetMeta[];
  onPatchElement: (patch: Partial<NoteElement>) => void;
  onEditText: () => void;
  onCropElement: (id: string) => void;
  onAddElement: (type: ElementType, patch?: Partial<NoteElement>) => void;
  onUpdateToolStyle: <K extends keyof ToolStyleState>(tool: K, patch: Partial<ToolStyleState[K]>) => void;
  onAddAsset: (asset: AssetMeta) => void;
  onReplaceAsset: (oldId: string, asset: AssetMeta) => void;
  onAddSticker: (asset: AssetMeta) => void;
  onReplaceSticker: (oldId: string, asset: AssetMeta) => void;
  onDeleteSticker: (id: string) => void;
  onAddFont: (font: AssetMeta) => void;
  onUseSystemFont: (font: SystemFont) => Promise<string>;
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4">
      <div className="mb-4">
        <Typography.Title heading={6} style={{ margin: 0 }}>
          控制
        </Typography.Title>
        <div className="text-xs text-black/45">元素属性和绘制前样式与图层列表分离</div>
      </div>
      {selectedElement ? (
        <ElementControls
          element={selectedElement}
          assets={assets}
          stickers={stickers}
          fonts={fonts}
          onPatch={onPatchElement}
          onEditText={onEditText}
          onCropElement={onCropElement}
          onAddSticker={onAddSticker}
          onReplaceSticker={onReplaceSticker}
          onDeleteSticker={onDeleteSticker}
          onAddFont={onAddFont}
          onUseSystemFont={onUseSystemFont}
        />
      ) : (
        <ToolPresetControls
          tool={tool}
          toolStyles={toolStyles}
          stickers={stickers}
          fonts={fonts}
          onUpdateToolStyle={onUpdateToolStyle}
          onAddElement={onAddElement}
          onAddSticker={onAddSticker}
          onReplaceSticker={onReplaceSticker}
          onDeleteSticker={onDeleteSticker}
          onAddFont={onAddFont}
          onUseSystemFont={onUseSystemFont}
        />
      )}
    </div>
  );
}

function ElementControls({
  element,
  assets,
  stickers,
  fonts,
  onPatch,
  onEditText,
  onCropElement,
  onAddSticker,
  onReplaceSticker,
  onDeleteSticker,
  onAddFont,
  onUseSystemFont,
}: {
  element: NoteElement;
  assets: AssetMeta[];
  stickers: AssetMeta[];
  fonts: AssetMeta[];
  onPatch: (patch: Partial<NoteElement>) => void;
  onEditText: () => void;
  onCropElement: (id: string) => void;
  onAddSticker: (asset: AssetMeta) => void;
  onReplaceSticker: (oldId: string, asset: AssetMeta) => void;
  onDeleteSticker: (id: string) => void;
  onAddFont: (font: AssetMeta) => void;
  onUseSystemFont: (font: SystemFont) => Promise<string>;
}) {
  const style = element.style ?? {};
  if (element.type === 'text') {
    return (
      <PanelCard title="文字属性" action={<Button size="small" icon={<IconEdit />} onClick={onEditText}>编辑文字</Button>}>
        <TextStyleControls
          value={{
            fontSize: Number(style.fontSize ?? 22),
            color: String(style.color ?? '#2f2a24'),
            background: String(style.background ?? ''),
            fontFamily: String(style.fontFamily ?? ''),
            borderColor: String(style.borderColor ?? '#2f2a24'),
            borderWidth: Number(style.borderWidth ?? 0),
            borderStyle: String(style.borderStyle ?? 'solid'),
            borderRadius: Number(style.borderRadius ?? 0),
            width: element.width,
            height: element.height,
          }}
          fonts={fonts}
          onPatch={(patch) => {
            const { width, height, ...stylePatch } = patch;
            onPatch({
              ...(width !== undefined ? { width } : {}),
              ...(height !== undefined ? { height } : {}),
              style: { ...style, ...stylePatch },
            });
          }}
          onAddFont={onAddFont}
          onUseSystemFont={onUseSystemFont}
        />
      </PanelCard>
    );
  }
  if (element.type === 'drawing' || (element.type === 'tape' && element.points?.length)) {
    return (
      <PanelCard title={element.type === 'tape' ? '胶带笔迹' : '画笔笔迹'}>
        <BrushControls
          value={{
            stroke: String(style.stroke ?? (element.type === 'tape' ? '#f2cf72' : '#446f64')),
            strokeWidth: Number(style.strokeWidth ?? (element.type === 'tape' ? 22 : 6)),
            tapePattern: String(style.tapePattern ?? 'dashes'),
          }}
          type={element.type === 'tape' ? 'tape' : 'drawing'}
          onPatch={(patch) => onPatch({ style: { ...style, ...patch } })}
        />
      </PanelCard>
    );
  }
  if (element.type === 'sticker') {
    return (
      <PanelCard title="贴纸属性">
        <StickerControls
          stickers={stickers}
          value={{ assetId: element.assetId ?? '', width: element.width, height: element.height }}
          onPatch={(patch) =>
            onPatch({
              ...(patch.assetId !== undefined ? { assetId: patch.assetId } : {}),
              ...(patch.width !== undefined ? { width: patch.width } : {}),
              ...(patch.height !== undefined ? { height: patch.height } : {}),
            })
          }
          onAddSticker={onAddSticker}
          onReplaceSticker={onReplaceSticker}
          onDeleteSticker={onDeleteSticker}
        />
      </PanelCard>
    );
  }
  if (element.type === 'image') {
    return (
      <PanelCard title="图片属性">
        <MediaControls element={element} assets={assets} onPatch={onPatch} onCrop={() => onCropElement(element.id)} />
      </PanelCard>
    );
  }
  return (
    <PanelCard title="元素属性">
      <Empty description="当前元素暂时没有专用控制项" />
    </PanelCard>
  );
}

function ToolPresetControls({
  tool,
  toolStyles,
  stickers,
  fonts,
  onUpdateToolStyle,
  onAddElement,
  onAddSticker,
  onReplaceSticker,
  onDeleteSticker,
  onAddFont,
  onUseSystemFont,
}: {
  tool: ToolMode;
  toolStyles: ToolStyleState;
  stickers: AssetMeta[];
  fonts: AssetMeta[];
  onUpdateToolStyle: <K extends keyof ToolStyleState>(tool: K, patch: Partial<ToolStyleState[K]>) => void;
  onAddElement: (type: ElementType, patch?: Partial<NoteElement>) => void;
  onAddSticker: (asset: AssetMeta) => void;
  onReplaceSticker: (oldId: string, asset: AssetMeta) => void;
  onDeleteSticker: (id: string) => void;
  onAddFont: (font: AssetMeta) => void;
  onUseSystemFont: (font: SystemFont) => Promise<string>;
}) {
  if (tool === 'text') {
    return (
      <PanelCard title="新文字样式">
        <TextStyleControls value={toolStyles.text} fonts={fonts} onPatch={(patch) => onUpdateToolStyle('text', patch)} onAddFont={onAddFont} onUseSystemFont={onUseSystemFont} />
        <div className="mt-3 text-xs leading-5 text-black/45">选择文本工具后，在画布上点击位置再创建文字。</div>
      </PanelCard>
    );
  }
  if (tool === 'drawing' || tool === 'tape') {
    const isTape = tool === 'tape';
    return (
      <PanelCard title={isTape ? '胶带笔样式' : '画笔样式'}>
        <BrushControls
          type={tool}
          value={isTape ? toolStyles.tape : { ...toolStyles.drawing, tapePattern: 'none' }}
          onPatch={(patch) => onUpdateToolStyle(tool, patch as any)}
        />
      </PanelCard>
    );
  }
  if (tool === 'sticker') {
    return (
      <PanelCard title="新贴纸样式">
        <StickerControls
          stickers={stickers}
          value={toolStyles.sticker}
          onPatch={(patch) => onUpdateToolStyle('sticker', patch)}
          onAddSticker={onAddSticker}
          onReplaceSticker={onReplaceSticker}
          onDeleteSticker={onDeleteSticker}
        />
        <div className="mt-3 text-xs leading-5 text-black/45">选择贴纸后，在画布上点击位置再放置。</div>
      </PanelCard>
    );
  }
  return (
    <PanelCard title="当前工具">
      <div className="text-sm leading-6 text-black/55">{tool === 'pan' ? '移动画布时不会选中或移动元素。' : '选中元素后可在这里编辑属性；选择画笔、胶带笔、文字或贴纸可预设新元素样式。'}</div>
    </PanelCard>
  );
}

function PanelCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] border border-black/10 bg-white/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Typography.Text strong>{title}</Typography.Text>
        {action}
      </div>
      {children}
    </div>
  );
}

function TextStyleControls({
  value,
  fonts,
  onPatch,
  onAddFont,
  onUseSystemFont,
}: {
  value: ToolStyleState['text'];
  fonts: AssetMeta[];
  onPatch: (patch: Partial<ToolStyleState['text']>) => void;
  onAddFont: (font: AssetMeta) => void;
  onUseSystemFont: (font: SystemFont) => Promise<string>;
}) {
  return (
    <div>
      <Swatches label="文本背景" value={value.background} values={backgroundSwatches} onChange={(background) => onPatch({ background })} />
      <Swatches label="文字颜色" value={value.color} values={textSwatches} onChange={(color) => onPatch({ color })} />
      <Swatches label="边框颜色" value={value.borderColor} values={textSwatches} onChange={(borderColor) => onPatch({ borderColor })} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="字号" value={Number(value.fontSize ?? 22)} min={8} max={120} onChange={(fontSize) => onPatch({ fontSize })} />
        <NumberField label="宽度" value={Math.round(value.width)} min={40} max={1200} onChange={(width) => onPatch({ width })} />
        <NumberField label="高度" value={Math.round(value.height)} min={32} max={1200} onChange={(height) => onPatch({ height })} />
        <NumberField label="边框宽度" value={Number(value.borderWidth ?? 0)} min={0} max={24} onChange={(borderWidth) => onPatch({ borderWidth })} />
        <NumberField label="圆角" value={Number(value.borderRadius ?? 0)} min={0} max={80} onChange={(borderRadius) => onPatch({ borderRadius })} />
      </div>
      <label className="mt-3 block">
        <span className="mb-1 block text-xs text-black/45">边框样式</span>
        <Select
          value={value.borderStyle || 'solid'}
          style={{ width: '100%' }}
          optionList={[
            { label: '实线', value: 'solid' },
            { label: '虚线', value: 'dashed' },
            { label: '点线', value: 'dotted' },
            { label: '双线', value: 'double' },
          ]}
          onChange={(borderStyle) => onPatch({ borderStyle: String(borderStyle) })}
        />
      </label>
      <FontSelector value={value.fontFamily} fonts={fonts} onChange={(fontFamily) => onPatch({ fontFamily })} onAddFont={onAddFont} onUseSystemFont={onUseSystemFont} />
    </div>
  );
}

function BrushControls({
  type,
  value,
  onPatch,
}: {
  type: 'drawing' | 'tape';
  value: { stroke: string; strokeWidth: number; tapePattern: string };
  onPatch: (patch: { stroke?: string; strokeWidth?: number; tapePattern?: string }) => void;
}) {
  return (
    <div>
      <Swatches label={type === 'tape' ? '胶带颜色' : '画笔颜色'} value={value.stroke} values={type === 'tape' ? tapeSwatches : brushSwatches} onChange={(stroke) => onPatch({ stroke })} />
      <NumberField label={type === 'tape' ? '胶带宽度' : '笔触宽度'} value={Number(value.strokeWidth)} min={1} max={80} onChange={(strokeWidth) => onPatch({ strokeWidth })} />
      {type === 'tape' ? (
        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-black/45">图案</span>
          <Select
            value={value.tapePattern}
            style={{ width: '100%' }}
            optionList={[
              { label: '虚线点缀', value: 'dashes' },
              { label: '斜纹纸胶带', value: 'stripe' },
              { label: '圆点纸胶带', value: 'dots' },
              { label: '纯色胶带', value: 'solid' },
            ]}
            onChange={(next) => onPatch({ tapePattern: String(next) })}
          />
        </label>
      ) : null}
    </div>
  );
}

function StickerControls({
  stickers,
  value,
  onPatch,
  onAddSticker,
  onReplaceSticker,
  onDeleteSticker,
}: {
  stickers: AssetMeta[];
  value: ToolStyleState['sticker'];
  onPatch: (patch: Partial<ToolStyleState['sticker']>) => void;
  onAddSticker: (asset: AssetMeta) => void;
  onReplaceSticker: (oldId: string, asset: AssetMeta) => void;
  onDeleteSticker: (id: string) => void;
}) {
  const chooseBuiltinSticker = async (url: string, name: string) => {
    try {
      const asset = await createAssetFromUrl(url, name, 'stickers');
      onAddSticker(asset);
      onPatch({ assetId: asset.id });
    } catch (error) {
      Toast.error(`贴纸载入失败：${String(error)}`);
    }
  };

  const importSticker = async (file: File) => {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
      return;
    }
    const asset = await createAssetFromFile(file, 'stickers');
    onAddSticker(asset);
    onPatch({ assetId: asset.id });
    Toast.success('贴纸已导入');
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-black/45">贴纸库</span>
        <Upload
          action=""
          accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
          multiple
          showUploadList={false}
          uploadTrigger="custom"
          onFileChange={(files: File[]) => {
            files.forEach((file) => void importSticker(file));
          }}
        >
          <Button size="small" icon={<IconUpload />}>
            上传贴纸
          </Button>
        </Upload>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {stickers.map((asset) => {
          const src = asset.dataUrl ?? (asset.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);
          return (
            <button
              key={asset.id}
              type="button"
              className={`group relative h-20 rounded-[8px] border bg-white p-1 ${value.assetId === asset.id ? 'border-[#2f6fed] ring-2 ring-[#2f6fed]/20' : 'border-black/10'}`}
              onClick={() => onPatch({ assetId: asset.id })}
              onContextMenu={(event) => {
                event.preventDefault();
                onDeleteSticker(asset.id);
              }}
              title={asset.name}
            >
              {src ? <img className="h-full w-full object-contain" src={src} alt="" /> : <IconImage />}
              <span
                role="button"
                tabIndex={0}
                className="absolute right-1 top-1 hidden rounded bg-white/90 px-1 text-xs text-red-600 shadow group-hover:block"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteSticker(asset.id);
                }}
                onKeyDown={() => undefined}
              >
                删
              </span>
            </button>
          );
        })}
        {builtinStickers.map((sticker) => (
          <button
            key={sticker.id}
            type="button"
            className="h-20 rounded-[8px] border border-dashed border-[#2f6fed]/35 bg-white p-1"
            onClick={() => void chooseBuiltinSticker(sticker.url, sticker.name)}
            title={sticker.name}
          >
            <img className="h-full w-full object-contain" src={sticker.url} alt="" />
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <NumberField label="宽度" value={Math.round(value.width)} min={32} max={800} onChange={(width) => onPatch({ width })} />
        <NumberField label="高度" value={Math.round(value.height)} min={32} max={800} onChange={(height) => onPatch({ height })} />
      </div>
    </div>
  );
}

function MediaControls({
  element,
  assets,
  onPatch,
  onCrop,
}: {
  element: NoteElement;
  assets: AssetMeta[];
  onPatch: (patch: Partial<NoteElement>) => void;
  onCrop: () => void;
}) {
  const asset = assets.find((item) => item.id === element.assetId);
  const src = asset?.dataUrl ?? (asset?.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);
  return (
    <div>
      <div className="mb-3 overflow-hidden rounded-[8px] border border-black/10 bg-white">
        {src ? <img className="h-32 w-full object-contain" src={src} alt="" /> : <Empty description="图片素材缺失" />}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="宽度" value={Math.round(element.width)} min={32} max={1600} onChange={(width) => onPatch({ width })} />
        <NumberField label="高度" value={Math.round(element.height)} min={32} max={1600} onChange={(height) => onPatch({ height })} />
      </div>
      <Button className="mt-3" size="small" icon={<IconCrop />} disabled={!src} onClick={onCrop}>
        裁剪图片
      </Button>
    </div>
  );
}

function FontSelector({
  value,
  fonts,
  onChange,
  onAddFont,
  onUseSystemFont,
}: {
  value: string;
  fonts: AssetMeta[];
  onChange: (fontFamily: string) => void;
  onAddFont: (font: AssetMeta) => void;
  onUseSystemFont: (font: SystemFont) => Promise<string>;
}) {
  const [systemFonts, setSystemFonts] = useState<SystemFont[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (AssetService as any)
      .GetSystemFonts()
      .then((items: SystemFont[]) => {
        if (alive) {
          setSystemFonts(items ?? []);
        }
      })
      .catch(() => {
        if (alive) {
          setSystemFonts([]);
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const optionList = [
    { label: '默认字体', value: '' },
    ...fonts.map((font) => ({ label: `已打包：${fontDisplayName(font)}`, value: fontFamilyForAsset(font) })),
    ...systemFonts.map((font) => ({ label: `系统：${font.family}`, value: `system::${font.path}` })),
  ];

  const handleChange = async (nextValue: unknown) => {
    const selected = String(nextValue ?? '');
    if (!selected.startsWith('system::')) {
      onChange(selected);
      return;
    }
    const path = selected.slice('system::'.length);
    const font = systemFonts.find((item) => item.path === path);
    if (!font) {
      return;
    }
    const fontFamily = await onUseSystemFont(font);
    if (fontFamily) {
      onChange(fontFamily);
    }
  };

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-black/45">
        <IconFont />
        <span>字体</span>
      </div>
      <Select
        filter
        loading={loading}
        value={value || ''}
        style={{ width: '100%' }}
        optionList={optionList}
        dropdownMatchSelectWidth={false}
        onChange={handleChange}
      />
      <Upload
        action=""
        accept=".ttf,.otf,.woff,.woff2"
        showUploadList={false}
        uploadTrigger="custom"
        onFileChange={(files: File[]) => {
          files.forEach((file) => {
            void createAssetFromFile(file, 'fonts').then((font) => {
              onAddFont(font);
              onChange(fontFamilyForAsset(font));
            });
          });
        }}
      >
        <Button className="mt-2" size="small" icon={<IconUpload />}>
          导入字体文件
        </Button>
      </Upload>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-black/45">{label}</span>
      <input
        className="h-8 w-full rounded-[6px] border border-black/10 bg-white px-2 text-sm outline-none"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Swatches({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-2 text-xs text-black/45">{label}</div>
      <div className="flex flex-wrap gap-2">
        {values.map((item) => (
          <button
            key={item || 'transparent'}
            type="button"
            className={`h-7 w-7 rounded-full border ${value === item ? 'border-[#2f6fed] ring-2 ring-[#2f6fed]/20' : 'border-black/15'}`}
            style={{
              background: item || 'linear-gradient(135deg, transparent 45%, #d33 46%, #d33 54%, transparent 55%), #fff',
            }}
            onClick={() => onChange(item)}
            aria-label={item || '透明'}
          />
        ))}
        <ColorField value={value || '#ffffff'} onChange={onChange} />
      </div>
    </div>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const colorValue = ColorPicker.colorStringToValue(normalizeColor(value));
  return (
    <ColorPicker
      usePopover
      alpha
      value={colorValue}
      onChange={(next: any) => {
        onChange(next?.hex || rgbaToString(next?.rgba) || normalizeColor(value));
      }}
    >
      <button
        type="button"
        className="h-7 w-9 cursor-pointer rounded border border-black/15 bg-white"
        style={{ background: normalizeColor(value) }}
        aria-label="打开颜色选择器"
      />
    </ColorPicker>
  );
}

function InspectorCropModal({ elementId, onClose }: { elementId: string | null; onClose: () => void }) {
  const { document, addAsset, addSticker, updateElement } = useDocument();
  const element = elementId ? document.elements.find((item) => item.id === elementId) : undefined;
  const asset = element ? [...document.assets, ...document.stickers].find((item) => item.id === element.assetId) : undefined;
  const src = asset?.dataUrl ?? (asset?.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);

  const apply = async (dataUrl: string) => {
    if (element) {
      const group = element.type === 'sticker' ? 'stickers' : 'assets';
      const nextAsset = await createAssetFromDataUrl(dataUrl, `${asset?.name ?? '图片'}-裁剪.png`, group, 'image/png');
      if (element.type === 'sticker') {
        addSticker(nextAsset);
      } else {
        addAsset(nextAsset);
      }
      updateElement(element.id, {
        assetId: nextAsset.id,
        style: { ...(element.style ?? {}), fit: 'contain', objectPosition: '50% 50%' },
      });
    }
    onClose();
  };

  return (
    <ImageCropModal
      title="裁剪图片"
      visible={Boolean(element && src)}
      src={src}
      aspectRatio={element ? element.width / Math.max(1, element.height) : undefined}
      onClose={onClose}
      onApply={apply}
    />
  );
}

function normalizeColor(value: string) {
  return value && value !== 'transparent' ? value : '#ffffff';
}

function rgbaToString(rgba?: { r: number; g: number; b: number; a: number }) {
  if (!rgba) {
    return '';
  }
  return `rgba(${rgba.r},${rgba.g},${rgba.b},${rgba.a})`;
}

function LayerPreview({ element, assets }: { element: NoteElement; assets: AssetMeta[] }) {
  const style = element.style ?? {};
  if (element.type === 'text') {
    return (
      <div className="grid h-11 w-14 shrink-0 place-items-center rounded-[6px] border border-black/10 bg-white text-sm text-black/70">
        <IconText />
      </div>
    );
  }
  if (element.type === 'image' || element.type === 'sticker') {
    const asset = assets.find((item) => item.id === element.assetId);
    const src = asset?.dataUrl ?? (asset?.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);
    return (
      <div className="grid h-11 w-14 shrink-0 place-items-center overflow-hidden rounded-[6px] border border-black/10 bg-transparent text-black/45">
        {src ? (
          <img className="h-full w-full object-contain" src={src} alt="" />
        ) : style.background ? (
          <div className="h-full w-full" style={{ background: String(style.background) }} />
        ) : (
          <IconImage />
        )}
      </div>
    );
  }
  if (element.type === 'drawing' || element.type === 'tape') {
    return (
      <div className="h-11 w-14 shrink-0 rounded-[6px] border border-black/10 bg-white p-2">
        <div
          className="h-full w-full rounded-full"
          style={{ borderTop: `${element.type === 'tape' ? 8 : 4}px solid ${String(style.stroke ?? '#4f7f73')}` }}
        />
      </div>
    );
  }
  return <div className="h-11 w-14 shrink-0 rounded-[6px] border border-black/10 bg-white" />;
}

function layerTitle(element: NoteElement, assets: AssetMeta[]) {
  const displayName = element.style?.displayName;
  if (typeof displayName === 'string' && displayName.trim()) {
    return displayName.trim();
  }
  if (element.type === 'text') {
    return stripHtml(element.content || '文本');
  }
  if (element.type === 'image' || element.type === 'sticker') {
    return assets.find((asset) => asset.id === element.assetId)?.name ?? (element.type === 'sticker' ? '贴纸' : '图片');
  }
  if (element.type === 'tape') {
    return element.points?.length ? '胶带笔迹' : '胶带';
  }
  if (element.type === 'drawing') {
    return '画笔笔迹';
  }
  return element.type;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '文本';
}

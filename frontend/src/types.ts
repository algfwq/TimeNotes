export type ElementType = 'text' | 'image' | 'sticker' | 'tape' | 'shape' | 'drawing';

export interface NotePage {
  id: string;
  title: string;
  width: number;
  height: number;
  background: string;
  // 背景图片以素材 asset 的形式打包，页面只保存引用和裁剪参数。
  backgroundAssetId?: string;
  backgroundFit?: 'cover' | 'contain';
  backgroundCropX?: number;
  backgroundCropY?: number;
}

export interface NoteElement {
  id: string;
  pageId: string;
  type: ElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  content?: string;
  assetId?: string;
  style?: Record<string, string | number | boolean>;
  points?: number[];
}

export type WorkspaceTabMode = 'edit' | 'reader';

export interface DocumentHistory {
  past: NoteDocument[];
  future: NoteDocument[];
}

export interface WorkspaceTab {
  id: string;
  title: string;
  mode: WorkspaceTabMode;
  document: NoteDocument;
  activePageId: string;
  sourcePath?: string;
  history?: DocumentHistory;
}

export interface AssetMeta {
  id: string;
  name: string;
  hash: string;
  mimeType: string;
  size: number;
  path: string;
  dataBase64?: string;
  dataUrl?: string;
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  page: NotePage;
  elements: NoteElement[];
}

export interface NoteDocument {
  formatVersion: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  pages: NotePage[];
  elements: NoteElement[];
  assets: AssetMeta[];
  stickers: AssetMeta[];
  fonts: AssetMeta[];
  templates: TemplateDef[];
}

export interface NoteManifest {
  formatVersion: number;
  appVersion: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  documentPath: string;
  yjsStatePath: string;
  assets: AssetMeta[];
  stickers: AssetMeta[];
  fonts: AssetMeta[];
}

export interface NotePackage {
  manifest: NoteManifest;
  document: NoteDocument;
  yjsState: string;
  assets: AssetMeta[];
  stickers: AssetMeta[];
  fonts: AssetMeta[];
  thumbnail: string;
}

export type ToolMode = 'select' | 'pan' | 'text' | 'image' | 'sticker' | 'tape' | 'shape' | 'drawing';

export interface ToolStyleState {
  text: {
    fontSize: number;
    color: string;
    background: string;
    fontFamily: string;
    borderColor: string;
    borderWidth: number;
    borderStyle: string;
    borderRadius: number;
    width: number;
    height: number;
  };
  drawing: {
    stroke: string;
    strokeWidth: number;
  };
  tape: {
    stroke: string;
    strokeWidth: number;
    tapePattern: string;
  };
  sticker: {
    assetId: string;
    width: number;
    height: number;
  };
}

export interface PendingPlacement {
  type: Extract<ElementType, 'text' | 'image' | 'sticker'>;
  patch?: Partial<NoteElement>;
}

// 只把字体文件路径从后端暴露给前端；真正使用时再导入字体二进制，避免一次性加载所有系统字体。
export interface SystemFont {
  name: string;
  family: string;
  path: string;
}

export interface PresenceUser {
  name: string;
  color: string;
  pageId: string;
  selectedElementId?: string;
}

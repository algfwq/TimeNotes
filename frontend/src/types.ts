export type ElementType = 'text' | 'code' | 'image' | 'sticker' | 'audio' | 'video' | 'model' | 'tape' | 'shape' | 'drawing';

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

export type WorkspaceTabMode = 'edit' | 'reader' | 'home';

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
  // 包内封面 data URL；保存时 createPackage 会带回，避免每次写空 thumbnail 覆盖。
  thumbnail?: string;
  history?: DocumentHistory;
  lastSavedHash?: string;
  saveInProgress?: boolean;
  pendingSave?: boolean;
  lastSaveError?: string;
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
  audioTitle?: string;
  audioArtist?: string;
  audioAlbum?: string;
  duration?: number;
  coverMimeType?: string;
  coverDataBase64?: string;
  coverDataUrl?: string;
  videoWidth?: number;
  videoHeight?: number;
  posterDataBase64?: string;
  posterDataUrl?: string;
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
  audios: AssetMeta[];
  videos: AssetMeta[];
  models: AssetMeta[];
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
  audios: AssetMeta[];
  videos: AssetMeta[];
  models: AssetMeta[];
}

export interface NotePackage {
  manifest: NoteManifest;
  document: NoteDocument;
  yjsState: string;
  assets: AssetMeta[];
  stickers: AssetMeta[];
  fonts: AssetMeta[];
  audios: AssetMeta[];
  videos: AssetMeta[];
  models: AssetMeta[];
  thumbnail: string;
}

export type ToolMode = 'select' | 'pan' | 'text' | 'code' | 'image' | 'sticker' | 'audio' | 'video' | 'model' | 'tape' | 'drawing';

export interface ToolStyleState {
  text: {
    fontSize: number;
    color: string;
    background: string;
    fontFamily: string;
    inlineCodeColor: string;
    inlineCodeFontFamily: string;
    blockquoteColor: string;
    blockquoteFontFamily: string;
    borderColor: string;
    borderWidth: number;
    borderStyle: string;
    borderRadius: number;
    width: number;
    height: number;
  };
  code: {
    language: string;
    fontSize: number;
    color: string;
    background: string;
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
  type: Extract<ElementType, 'text' | 'code' | 'image' | 'sticker' | 'audio' | 'video' | 'model'>;
  patch?: Partial<NoteElement>;
}

export type ResourceGroup = 'assets' | 'stickers' | 'fonts' | 'audios' | 'videos' | 'models';

export interface ResourceTransferProgress {
  key: string;
  group: ResourceGroup;
  assetId: string;
  name: string;
  receivedChunks: number;
  totalChunks: number;
  receivedBytes: number;
  totalBytes: number;
  progress: number;
}

// 只把字体文件路径从后端暴露给前端；真正使用时再导入字体二进制，避免一次性加载所有系统字体。
export interface SystemFont {
  name: string;
  family: string;
  path: string;
}

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  pageId: string;
  cursor?: {
    pageId: string;
    x: number;
    y: number;
  } | null;
  selectedElementId?: string | null;
  editingElementId?: string | null;
  transport?: 'p2p' | 'relay' | 'offline';
  lastSeen?: string;
  role?: 'host' | 'collaborator';
}

export interface ChatMessage {
  id: string;
  text: string;
  user: PresenceUser;
  sentAt: string;
  local?: boolean;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { DocumentService } from '../../bindings/changeme';
import { base64ToBytes, bytesToBase64, dataUrlToBase64 } from '../lib/base64';
import { createId } from '../lib/ids';
import { createSeedDocument } from '../data/seed';
import type {
  AssetMeta,
  ElementType,
  NoteDocument,
  NoteElement,
  NotePackage,
  NotePage,
  PendingPlacement,
  ToolStyleState,
  ToolMode,
  WorkspaceTab,
  WorkspaceTabMode,
} from '../types';

interface DocumentContextValue {
  tabs: WorkspaceTab[];
  activeTabId: string;
  activeTabMode: WorkspaceTabMode;
  document: NoteDocument;
  activePageId: string;
  activePage: NotePage;
  selectedElementId?: string;
  selectedElement?: NoteElement;
  editingElementId?: string;
  zoom: number;
  tool: ToolMode;
  toolStyles: ToolStyleState;
  pendingPlacement?: PendingPlacement;
  yDoc: Y.Doc;
  setZoom: (zoom: number) => void;
  setTool: (tool: ToolMode) => void;
  updateToolStyle: <K extends keyof ToolStyleState>(tool: K, patch: Partial<ToolStyleState[K]>) => void;
  switchTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  openReadTab: () => void;
  setActivePage: (pageId: string) => void;
  addPage: () => void;
  deletePage: (pageId: string) => void;
  reorderPage: (sourcePageId: string, targetPageId: string) => void;
  updatePage: (pageId: string, patch: Partial<NotePage>) => void;
  renamePage: (pageId: string, title: string) => void;
  selectElement: (id?: string) => void;
  startEditing: (id: string) => void;
  stopEditing: () => void;
  armPlacement: (placement?: PendingPlacement) => void;
  placePendingElement: (x: number, y: number) => void;
  replaceDocument: (document: NoteDocument) => void;
  loadPackage: (note: NotePackage, sourcePath?: string) => void;
  createPackage: () => NotePackage;
  createNewDocument: () => Promise<void>;
  updateElement: (id: string, patch: Partial<NoteElement>, options?: DocumentUpdateOptions) => void;
  addElement: (type: ElementType, patch?: Partial<NoteElement>) => void;
  deleteElement: (id: string) => void;
  deleteSelectedElement: () => void;
  duplicateElement: (id: string) => void;
  renameElement: (id: string, title: string) => void;
  moveElementLayer: (id: string, direction: 'up' | 'down' | 'front' | 'back') => void;
  reorderElementLayer: (sourceElementId: string, targetElementId: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  addAsset: (asset: AssetMeta) => void;
  replaceAsset: (oldId: string, asset: AssetMeta) => void;
  deleteAsset: (id: string) => void;
  addSticker: (asset: AssetMeta) => void;
  replaceSticker: (oldId: string, asset: AssetMeta) => void;
  deleteSticker: (id: string) => void;
  addFont: (font: AssetMeta) => void;
}

const DocumentContext = createContext<DocumentContextValue | null>(null);

// v3 开始把贴纸资源从普通图片素材中拆出，避免素材栏和贴纸面板互相污染。
const currentFormatVersion = 3;
const localOrigin = 'timenotes-react';
const collaborationRemoteOrigin = 'timenotes-collaboration-remote';
const collaborationSnapshotMapName = 'snapshot';
const collaborationResourceMapName = 'resources';
const collaborationDocumentKeyPrefix = 'document:';
const maxHistorySteps = 80;

type ResourceGroup = 'assets' | 'stickers' | 'fonts';
type CollaborationSnapshotScope = { type: 'document' } | { type: 'page'; pageId: string };

interface DocumentUpdateOptions {
  history?: boolean;
  historyBase?: NoteDocument;
  collaborationScope?: CollaborationSnapshotScope;
}

interface CollaborationResourceEntry {
  group: ResourceGroup;
  asset: AssetMeta;
  signature: string;
}

interface CollaborationDocumentEntry {
  kind: 'document';
  clientId: string;
  updatedAt: string;
  activePageId?: string;
  scope?: CollaborationSnapshotScope;
  document: NoteDocument;
}

type CollaborationSnapshotValue = NoteDocument | CollaborationDocumentEntry;

const defaultToolStyles: ToolStyleState = {
  text: {
    fontSize: 22,
    color: '#2f2a24',
    background: '',
    fontFamily: '',
    borderColor: '#2f2a24',
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: 0,
    width: 220,
    height: 120,
  },
  drawing: {
    stroke: '#446f64',
    strokeWidth: 6,
  },
  tape: {
    stroke: '#f2cf72',
    strokeWidth: 22,
    tapePattern: 'dashes',
  },
  sticker: {
    assetId: '',
    width: 142,
    height: 142,
  },
};

function makeAssetDataUrl(asset: AssetMeta) {
  if (asset.dataUrl) {
    return asset.dataUrl;
  }
  if (asset.dataBase64) {
    return `data:${asset.mimeType || 'application/octet-stream'};base64,${asset.dataBase64}`;
  }
  return undefined;
}

function hydrateAsset(asset: AssetMeta): AssetMeta {
  return { ...asset, dataUrl: makeAssetDataUrl(asset) };
}

function mergeAssets(...groups: AssetMeta[][]) {
  const assetMap = new Map<string, AssetMeta>();
  groups.flat().forEach((asset) => {
    if (asset?.id) {
      assetMap.set(asset.id, hydrateAsset({ ...assetMap.get(asset.id), ...asset }));
    }
  });
  return Array.from(assetMap.values());
}

function normalizeDocument(
  nextDocument: NoteDocument,
  packageAssets: AssetMeta[] = [],
  packageStickers: AssetMeta[] = [],
  packageFonts: AssetMeta[] = [],
): NoteDocument {
  const seed = createSeedDocument();
  const pages = nextDocument.pages?.length ? nextDocument.pages : seed.pages;
  const elements = (nextDocument.elements ?? []).map((element) => ({
    ...element,
    x: Number(element.x) || 0,
    y: Number(element.y) || 0,
    width: Number(element.width) || 80,
    height: Number(element.height) || 40,
    rotation: Number(element.rotation) || 0,
    zIndex: Number(element.zIndex) || 0,
  }));
  return {
    formatVersion: currentFormatVersion,
    title: nextDocument.title || 'TimeNotes 手账',
    createdAt: nextDocument.createdAt || new Date().toISOString(),
    updatedAt: nextDocument.updatedAt || new Date().toISOString(),
    pages,
    elements: elements.map((element) => clampElementToPage(element, pages)),
    assets: mergeAssets(nextDocument.assets ?? [], packageAssets),
    stickers: mergeAssets(nextDocument.stickers ?? [], packageStickers),
    fonts: mergeAssets(nextDocument.fonts ?? [], packageFonts),
    templates: [],
  };
}

function cloneDocument(document: NoteDocument) {
  return JSON.parse(JSON.stringify(document)) as NoteDocument;
}

function cloneDocumentForHistory(document: NoteDocument) {
  const snapshot = cloneDocument(document);
  // 撤销历史不能保存 base64/dataURL，否则每次拖动都会复制整包图片，WebView2 很容易 OOM。
  return {
    ...snapshot,
    assets: snapshot.assets.map(stripTransientAssetData),
    stickers: snapshot.stickers.map(stripTransientAssetData),
    fonts: snapshot.fonts.map(stripTransientAssetData),
  };
}

function createTab(document: NoteDocument, mode: WorkspaceTabMode, sourcePath?: string): WorkspaceTab {
  const normalized = normalizeDocument(document);
  return {
    id: createId(mode === 'reader' ? 'reader' : 'tab'),
    title: mode === 'reader' ? `阅读：${normalized.title}` : normalized.title,
    mode,
    document: normalized,
    activePageId: normalized.pages[0]?.id ?? 'page-1',
    sourcePath,
    history: { past: [], future: [] },
  };
}

function stripTransientAssetData(asset: AssetMeta) {
  const { dataBase64, dataUrl, ...meta } = asset;
  return meta;
}

function compactResourceAsset(asset: AssetMeta) {
  const dataBase64 = asset.dataBase64 ?? (asset.dataUrl ? dataUrlToBase64(asset.dataUrl) : undefined);
  if (!dataBase64) {
    return stripTransientAssetData(asset);
  }
  const { dataUrl, ...meta } = asset;
  return { ...meta, dataBase64 };
}

function stripDocumentForCollaboration(document: NoteDocument): NoteDocument {
  return {
    ...document,
    assets: document.assets.map(stripTransientAssetData),
    stickers: document.stickers.map(stripTransientAssetData),
    fonts: document.fonts.map(stripTransientAssetData),
  };
}

function rememberResources(cache: Map<string, AssetMeta>, document: NoteDocument) {
  [...document.assets, ...document.stickers, ...document.fonts].forEach((asset) => {
    if (asset.id && (asset.dataBase64 || asset.dataUrl)) {
      cache.set(asset.id, asset);
    }
  });
}

function hydrateResourcesFromCache(document: NoteDocument, cache: Map<string, AssetMeta>) {
  const hydrate = (asset: AssetMeta) => hydrateAsset({ ...(cache.get(asset.id) ?? {}), ...asset });
  return {
    ...document,
    assets: document.assets.map(hydrate),
    stickers: document.stickers.map(hydrate),
    fonts: document.fonts.map(hydrate),
  };
}

function resourceGroups(document: NoteDocument): Array<[ResourceGroup, AssetMeta[]]> {
  return [
    ['assets', document.assets],
    ['stickers', document.stickers],
    ['fonts', document.fonts],
  ];
}

function resourceKey(group: ResourceGroup, id: string) {
  return `${group}:${id}`;
}

function resourceSignature(asset: AssetMeta) {
  return [asset.hash, asset.size, asset.mimeType, asset.dataBase64?.length ?? 0, asset.dataUrl?.length ?? 0].join(':');
}

function hydrateResourceForSync(asset: AssetMeta, cache: Map<string, AssetMeta>) {
  const cached = cache.get(asset.id);
  if (!cached) {
    return hydrateAsset(asset);
  }
  // 协作 document 快照为了性能会剥离 dataUrl/dataBase64；这里用本地缓存把资源二进制补回来。
  // 这样即使先收到“引用了某个字体/素材的文档”，后收到 resources map，也能在下一次同步时补发完整资源。
  return hydrateAsset({
    ...cached,
    ...asset,
    dataBase64: asset.dataBase64 ?? cached.dataBase64,
    dataUrl: asset.dataUrl ?? cached.dataUrl,
  });
}

function syncResourcesToYjs(resourceMap: Y.Map<CollaborationResourceEntry>, signatures: Map<string, string>, document: NoteDocument, cache: Map<string, AssetMeta>) {
  const localKeys = new Set<string>();
  resourceGroups(document).forEach(([group, assets]) => {
    assets.forEach((asset) => {
      if (!asset.id) {
        return;
      }
      const key = resourceKey(group, asset.id);
      const hydrated = hydrateResourceForSync(asset, cache);
      if (!hydrated.dataBase64 && !hydrated.dataUrl) {
        return;
      }
      localKeys.add(key);
      const compact = compactResourceAsset(hydrated);
      const signature = resourceSignature(compact);
      if (signatures.get(key) === signature && resourceMap.has(key)) {
        return;
      }
      signatures.set(key, signature);
      resourceMap.set(key, { group, asset: compact, signature });
    });
  });

  Array.from(signatures.keys()).forEach((key) => {
    if (!localKeys.has(key)) {
      signatures.delete(key);
    }
  });
  // 不在这里按 liveKeys 删除 resourceMap。多人协作时，A 的资源二进制可能先到，
  // A 的 document 快照后到；如果 B 在这个间隙同步本机文档并清理共享 resources，
  // 就会把 A 刚上传的图片/字体删掉，其他客户端只能看到资源 id，无法渲染。
}

function cacheResourcesFromYjs(resourceMap: Y.Map<CollaborationResourceEntry>, cache: Map<string, AssetMeta>) {
  // resources map 是协作中的二进制素材池；缓存到内存后，document 快照只需要引用 assetId。
  resourceMap.forEach((entry) => {
    if (entry?.asset?.id) {
      cache.set(entry.asset.id, hydrateAsset(entry.asset));
    }
  });
}

function collaborationDocumentKey(yDoc: Y.Doc) {
  // 每个 Y.Doc 客户端写自己的 document 槽位，避免多人同时更新同一个 key 时被覆盖。
  return `${collaborationDocumentKeyPrefix}${yDoc.clientID}`;
}

function unwrapCollaborationSnapshot(value: CollaborationSnapshotValue | undefined) {
  // 兼容旧的裸 NoteDocument 快照和新的带 scope 包装快照，保证历史房间仍能打开。
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if ('kind' in value && value.kind === 'document') {
    return {
      document: value.document,
      activePageId: value.activePageId,
      scope: value.scope ?? (value.activePageId ? { type: 'page' as const, pageId: value.activePageId } : undefined),
    };
  }
  if ('pages' in value && Array.isArray(value.pages) && 'elements' in value && Array.isArray(value.elements)) {
    return { document: value as NoteDocument };
  }
  return undefined;
}

function pickCollaborationSnapshot(snapshotMap: Y.Map<CollaborationSnapshotValue>, changedKeys?: Iterable<string>) {
  // 多客户端槽位同时存在时，选择更新时间最新的一份作为当前可见文档基线。
  const keys = Array.from(changedKeys ?? snapshotMap.keys()).filter((key) => key === 'document' || key.startsWith(collaborationDocumentKeyPrefix));
  let best: { document: NoteDocument; activePageId?: string; scope?: CollaborationSnapshotScope } | undefined;
  let bestTime = -Infinity;
  keys.forEach((key) => {
    const snapshot = unwrapCollaborationSnapshot(snapshotMap.get(key));
    if (!snapshot) {
      return;
    }
    const time = Date.parse(snapshot.document.updatedAt || snapshot.document.createdAt || '') || 0;
    if (!best || time >= bestTime) {
      best = snapshot;
      bestTime = time;
    }
  });
  return best;
}

function pageIdentitySignature(document: NoteDocument) {
  return document.pages.map((page) => page.id).join('|');
}

function mergeAssetList(current: AssetMeta[], incoming: AssetMeta[]) {
  // 素材合并优先保留已有二进制字段，避免对端只发轻量 metadata 时把本机缓存清空。
  const byId = new Map(current.map((asset) => [asset.id, asset]));
  incoming.forEach((asset) => {
    const existing = byId.get(asset.id);
    byId.set(
      asset.id,
      hydrateAsset({
        ...(existing ?? {}),
        ...asset,
        dataBase64: asset.dataBase64 ?? existing?.dataBase64,
        dataUrl: asset.dataUrl ?? existing?.dataUrl,
      }),
    );
  });
  return Array.from(byId.values());
}

function mergeCollaborationDocument(current: NoteDocument, incoming: NoteDocument, scope: CollaborationSnapshotScope | undefined, cache: Map<string, AssetMeta>) {
  // 页面级协同只替换当前页和该页元素；如果页面结构变化或 scope 缺失，退回整文档替换。
  const normalizedIncoming = normalizeDocument(hydrateResourcesFromCache(incoming, cache));
  if (!scope || scope.type === 'document') {
    return normalizedIncoming;
  }
  const pageId = scope.pageId;
  const incomingPage = normalizedIncoming.pages.find((page) => page.id === pageId);
  if (!incomingPage || !current.pages.some((page) => page.id === pageId) || pageIdentitySignature(current) !== pageIdentitySignature(normalizedIncoming)) {
    return normalizedIncoming;
  }
  const currentTime = Date.parse(current.updatedAt || current.createdAt || '') || 0;
  const incomingTime = Date.parse(normalizedIncoming.updatedAt || normalizedIncoming.createdAt || '') || 0;
  return normalizeDocument({
    ...current,
    title: incomingTime >= currentTime ? normalizedIncoming.title : current.title,
    updatedAt: incomingTime >= currentTime ? normalizedIncoming.updatedAt : current.updatedAt,
    assets: mergeAssetList(current.assets, normalizedIncoming.assets),
    stickers: mergeAssetList(current.stickers, normalizedIncoming.stickers),
    fonts: mergeAssetList(current.fonts, normalizedIncoming.fonts),
    pages: current.pages.map((page) => (page.id === pageId ? incomingPage : page)),
    elements: [
      ...current.elements.filter((element) => element.pageId !== pageId),
      ...normalizedIncoming.elements.filter((element) => element.pageId === pageId),
    ],
  });
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampElementToPage(element: NoteElement, pages: NotePage[]): NoteElement {
  // 普通元素持久化页面坐标并限制在纸张内；自由绘制和胶带使用 points，不按矩形裁剪。
  const page = pages.find((item) => item.id === element.pageId);
  if (!page || ((element.type === 'drawing' || element.type === 'tape') && element.points?.length)) {
    return element;
  }
  const width = clampNumber(Math.round(Number(element.width) || 1), 1, page.width);
  const height = clampNumber(Math.round(Number(element.height) || 1), 1, page.height);
  return {
    ...element,
    width,
    height,
    x: clampNumber(Math.round(Number(element.x) || 0), 0, Math.max(0, page.width - width)),
    y: clampNumber(Math.round(Number(element.y) || 0), 0, Math.max(0, page.height - height)),
  };
}

function hasElementChanged(previous: NoteElement, next: NoteElement, patch: Partial<NoteElement>) {
  // 拖拽过程中 Moveable 会频繁给出相同值，先做浅比较能减少无意义历史和 Yjs update。
  return Object.keys(patch).some((key) => {
    const field = key as keyof NoteElement;
    return !shallowEqualValue(previous[field], next[field]);
  });
}

function shallowEqualValue(first: unknown, second: unknown) {
  if (Object.is(first, second)) {
    return true;
  }
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length && first.every((value, index) => Object.is(value, second[index]));
  }
  if (first && second && typeof first === 'object' && typeof second === 'object') {
    const firstRecord = first as Record<string, unknown>;
    const secondRecord = second as Record<string, unknown>;
    const firstKeys = Object.keys(firstRecord);
    const secondKeys = Object.keys(secondRecord);
    return firstKeys.length === secondKeys.length && firstKeys.every((key) => Object.is(firstRecord[key], secondRecord[key]));
  }
  return false;
}

export function DocumentProvider({ children }: { children: React.ReactNode }) {
  // 每个工作区标签页拥有独立 Y.Doc，避免多个打开文档之间互相同步。
  const tabYDocsRef = useRef(new Map<string, Y.Doc>());
  // 资源缓存保存图片、贴纸、字体的二进制内容；协作 document 快照只保留轻量引用。
  const resourceCacheRef = useRef(new Map<string, AssetMeta>());
  const resourceSyncSignaturesRef = useRef(new WeakMap<Y.Doc, Map<string, string>>());
  // 下一次同步到 Yjs 时的作用域。页面内编辑尽量只广播 page scope，页面结构变化才升级为 document scope。
  const pendingCollaborationScopeRef = useRef<CollaborationSnapshotScope | undefined>();
  const activePageIdRef = useRef('');
  const skipNextYjsSyncRef = useRef(false);
  const skipYjsSyncUntilRef = useRef(0);
  const ensureTabYDoc = useCallback((tabId: string) => {
    // Y.Doc 不能随着 React render 反复创建；标签页首次出现时创建并缓存在 ref。
    let yDoc = tabYDocsRef.current.get(tabId);
    if (!yDoc) {
      yDoc = new Y.Doc();
      tabYDocsRef.current.set(tabId, yDoc);
    }
    return yDoc;
  }, []);
  const resourceSignaturesFor = useCallback((targetYDoc: Y.Doc) => {
    // 每个 Y.Doc 单独记录资源签名，避免跨标签误判“资源已经同步过”。
    let signatures = resourceSyncSignaturesRef.current.get(targetYDoc);
    if (!signatures) {
      signatures = new Map<string, string>();
      resourceSyncSignaturesRef.current.set(targetYDoc, signatures);
    }
    return signatures;
  }, []);
  const initialTab = useMemo(() => createTab(createSeedDocument(), 'edit'), []);
  // 多文档编辑由工作区标签维护；每个标签保存自己的文档快照和当前页。
  const [tabs, setTabs] = useState<WorkspaceTab[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState(initialTab.id);
  const [selectedElementId, setSelectedElementId] = useState<string | undefined>();
  const [editingElementId, setEditingElementId] = useState<string | undefined>();
  const [zoom, setZoom] = useState(0.82);
  const [toolState, setToolState] = useState<ToolMode>('select');
  const [toolStyles, setToolStyles] = useState<ToolStyleState>(defaultToolStyles);
  const [pendingPlacement, setPendingPlacement] = useState<PendingPlacement | undefined>();

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0], [activeTabId, tabs]);
  const document = activeTab.document;
  const activePageId = activeTab.activePageId;
  const activeTabMode = activeTab.mode;
  const activeYDoc = ensureTabYDoc(activeTab.id);
  const canUndo = Boolean(activeTab.history?.past.length);
  const canRedo = Boolean(activeTab.history?.future.length);

  useEffect(() => {
    activePageIdRef.current = activePageId;
  }, [activePageId]);

  useEffect(() => {
    // 当前文档变化时持续记住资源二进制，后续保存、协作合并或撤销都可以回填素材内容。
    rememberResources(resourceCacheRef.current, document);
  }, [document]);

  const syncToYjs = useCallback((nextDocument: NoteDocument, targetYDoc: Y.Doc, scope: CollaborationSnapshotScope, currentActivePageId: string) => {
    const snapshotMap = targetYDoc.getMap<CollaborationSnapshotValue>(collaborationSnapshotMapName);
    const resourceMap = targetYDoc.getMap<CollaborationResourceEntry>(collaborationResourceMapName);
    targetYDoc.transact(() => {
      // 高频画布编辑只同步轻量 document；图片、贴纸、字体二进制单独进入 resources map。
      // 日志里 35MB 的重复 doc_update 正是因为每次拖动都把素材 dataURL/base64 一起写进 document。
      syncResourcesToYjs(resourceMap, resourceSignaturesFor(targetYDoc), nextDocument, resourceCacheRef.current);
      // 每个客户端写独立槽位，避免多个协作者同时 set 同一个 Y.Map key 时被 Yjs 冲突合并规则吞掉更新。
      snapshotMap.set(collaborationDocumentKey(targetYDoc), {
        kind: 'document',
        clientId: String(targetYDoc.clientID),
        updatedAt: nextDocument.updatedAt,
        activePageId: scope.type === 'page' ? scope.pageId : currentActivePageId,
        scope,
        document: stripDocumentForCollaboration(nextDocument),
      });
    }, localOrigin);
  }, [resourceSignaturesFor]);

  useEffect(() => {
    if (activeTabMode !== 'edit') {
      return;
    }
    // 远端 Yjs update 刚落到 React 状态时，跳过一次本地回写，避免形成“收到后立即再广播”的回声。
    if (skipNextYjsSyncRef.current || Date.now() < skipYjsSyncUntilRef.current) {
      skipNextYjsSyncRef.current = false;
      return;
    }
    const scope = pendingCollaborationScopeRef.current ?? { type: 'page' as const, pageId: activePageIdRef.current };
    pendingCollaborationScopeRef.current = undefined;
    syncToYjs(document, activeYDoc, scope, activePageIdRef.current);
  }, [activeTabMode, activeYDoc, document, syncToYjs]);

  const updateActiveTab = useCallback(
    (updater: (current: WorkspaceTab) => WorkspaceTab) => {
      setTabs((currentTabs) =>
        currentTabs.map((tab) => {
          if (tab.id !== activeTabId) {
            return tab;
          }
          return updater(tab);
        }),
      );
    },
    [activeTabId],
  );

  const updateDocument = useCallback(
    (updater: (current: NoteDocument) => NoteDocument, options: DocumentUpdateOptions = {}) => {
      // 所有持久化文档变更都从这里进入：统一规范化、资源缓存、撤销栈和协作 scope。
      updateActiveTab((tab) => {
        if (tab.mode !== 'edit') {
          return tab;
        }
        rememberResources(resourceCacheRef.current, tab.document);
        const updated = updater(tab.document);
        if (updated === tab.document && !options.historyBase) {
          return tab;
        }
        const next = normalizeDocument({ ...updated, updatedAt: new Date().toISOString() });
        if (options.collaborationScope) {
          // 如果短时间内多个页面都发生变化，升级为 document scope，避免远端只替换其中一页造成结构不一致。
          const previousScope = pendingCollaborationScopeRef.current;
          pendingCollaborationScopeRef.current =
            options.collaborationScope.type === 'document' ||
            previousScope?.type === 'document' ||
            (previousScope?.type === 'page' && options.collaborationScope.type === 'page' && previousScope.pageId !== options.collaborationScope.pageId)
              ? { type: 'document' }
              : options.collaborationScope;
        }
        rememberResources(resourceCacheRef.current, next);
        const history = tab.history ?? { past: [], future: [] };
        const shouldRecordHistory = options.history !== false;
        return {
          ...tab,
          title: next.title,
          document: next,
          activePageId: next.pages.some((page) => page.id === tab.activePageId) ? tab.activePageId : next.pages[0]?.id ?? 'page-1',
          // 文档级撤销只记录持久化模型，不记录选择框、缩放、滚动等临时 UI 状态。
          history: shouldRecordHistory
            ? { past: [...history.past, cloneDocumentForHistory(options.historyBase ?? tab.document)].slice(-maxHistorySteps), future: [] }
            : history,
        };
      });
    },
    [updateActiveTab],
  );

  useEffect(() => {
    // 监听协作快照 map：远端写入 snapshot 后合并进当前 React 文档状态。
    const snapshotMap = activeYDoc.getMap<CollaborationSnapshotValue>(collaborationSnapshotMapName);
    const resourceMap = activeYDoc.getMap<CollaborationResourceEntry>(collaborationResourceMapName);
    const observer = (events: Y.YMapEvent<CollaborationSnapshotValue>, transaction: Y.Transaction) => {
      if (transaction.origin === localOrigin) {
        return;
      }
      const nextSnapshot = pickCollaborationSnapshot(snapshotMap, events.keysChanged);
      if (!nextSnapshot) {
        return;
      }
      // 先缓存资源，再合并 document；否则元素引用到的新 assetId 可能还找不到二进制数据。
      cacheResourcesFromYjs(resourceMap, resourceCacheRef.current);
      skipNextYjsSyncRef.current = transaction.origin === collaborationRemoteOrigin;
      if (transaction.origin === collaborationRemoteOrigin) {
        skipYjsSyncUntilRef.current = Date.now() + 150;
      }
      updateActiveTab((tab) => {
        if (tab.mode !== 'edit') {
          return tab;
        }
        const normalized = mergeCollaborationDocument(tab.document, nextSnapshot.document, nextSnapshot.scope, resourceCacheRef.current);
        rememberResources(resourceCacheRef.current, normalized);
        return { ...tab, title: normalized.title, document: normalized };
      });
    };
    snapshotMap.observe(observer);
    return () => snapshotMap.unobserve(observer);
  }, [activeYDoc, updateActiveTab]);

  useEffect(() => {
    // resources map 可能比 document 快照先到，也可能后到；单独监听可以补齐延迟到达的素材。
    const resourceMap = activeYDoc.getMap<CollaborationResourceEntry>(collaborationResourceMapName);
    const observer = (_events: Y.YMapEvent<CollaborationResourceEntry>, transaction: Y.Transaction) => {
      if (transaction.origin === localOrigin) {
        return;
      }
      cacheResourcesFromYjs(resourceMap, resourceCacheRef.current);
      skipNextYjsSyncRef.current = transaction.origin === collaborationRemoteOrigin;
      if (transaction.origin === collaborationRemoteOrigin) {
        skipYjsSyncUntilRef.current = Date.now() + 150;
      }
      updateActiveTab((tab) => {
        if (tab.mode !== 'edit') {
          return tab;
        }
        const hydrated = normalizeDocument(hydrateResourcesFromCache(tab.document, resourceCacheRef.current));
        return { ...tab, title: hydrated.title, document: hydrated };
      });
    };
    cacheResourcesFromYjs(resourceMap, resourceCacheRef.current);
    resourceMap.observe(observer);
    return () => resourceMap.unobserve(observer);
  }, [activeYDoc, updateActiveTab]);

  const activePage = useMemo(
    () => document.pages.find((page) => page.id === activePageId) ?? document.pages[0],
    [activePageId, document.pages],
  );

  const selectedElement = useMemo(
    () => document.elements.find((element) => element.id === selectedElementId),
    [document.elements, selectedElementId],
  );

  const clearSelection = useCallback(() => {
    setSelectedElementId(undefined);
    setEditingElementId(undefined);
  }, []);

  const setTool = useCallback(
    (tool: ToolMode) => {
      setToolState(tool);
      // 工具切换代表接下来要执行新动作，主动释放元素选择，避免右侧控制页继续显示旧元素属性。
      if (tool !== 'select') {
        clearSelection();
        setPendingPlacement(undefined);
      }
    },
    [clearSelection],
  );

  const updateToolStyle = useCallback(<K extends keyof ToolStyleState,>(tool: K, patch: Partial<ToolStyleState[K]>) => {
    setToolStyles((current) => ({
      ...current,
      [tool]: { ...current[tool], ...patch },
    }));
  }, []);

  const switchTab = useCallback(
    (tabId: string) => {
      if (!tabs.some((tab) => tab.id === tabId)) {
        return;
      }
      setActiveTabId(tabId);
      clearSelection();
      setToolState('select');
      setPendingPlacement(undefined);
    },
    [clearSelection, tabs],
  );

  const renameTab = useCallback((tabId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }
    setTabs((currentTabs) =>
      currentTabs.map((tab) => {
        if (tab.id !== tabId) {
          return tab;
        }
        if (tab.mode === 'edit') {
          const nextDocument = normalizeDocument({ ...tab.document, title: trimmed, updatedAt: new Date().toISOString() });
          return { ...tab, title: trimmed, document: nextDocument };
        }
        return { ...tab, title: trimmed };
      }),
    );
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      if (tabs.length <= 1) {
        return;
      }
      const index = tabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      const closedYDoc = tabYDocsRef.current.get(tabId);
      tabYDocsRef.current.delete(tabId);
      if (tabId !== activeTabId) {
        closedYDoc?.destroy();
      }
      setTabs(nextTabs);
      if (activeTabId === tabId) {
        setActiveTabId(nextTabs[Math.max(0, index - 1)]?.id ?? nextTabs[0].id);
      }
      clearSelection();
      setPendingPlacement(undefined);
    },
    [activeTabId, clearSelection, tabs],
  );

  const replaceDocument = useCallback(
    (nextDocument: NoteDocument) => {
      const normalized = normalizeDocument(nextDocument);
      rememberResources(resourceCacheRef.current, normalized);
      pendingCollaborationScopeRef.current = { type: 'document' };
      updateActiveTab((tab) => ({
        ...tab,
        mode: 'edit',
        title: normalized.title,
        document: normalized,
        activePageId: normalized.pages[0]?.id ?? 'page-1',
        history: { past: [], future: [] },
      }));
      clearSelection();
      setToolState('select');
      setPendingPlacement(undefined);
    },
    [clearSelection, updateActiveTab],
  );

  const loadPackage = useCallback(
    (note: NotePackage, sourcePath?: string) => {
      // 打开 .tnote 时优先以 document.json + 包内资源作为恢复源，Yjs state 只是协作增量的附加状态。
      const normalized = normalizeDocument(note.document, note.assets ?? [], note.stickers ?? [], note.fonts ?? []);
      rememberResources(resourceCacheRef.current, normalized);
      const tab = createTab(normalized, 'edit', sourcePath);
      const tabYDoc = new Y.Doc();
      if (note.yjsState) {
        try {
          Y.applyUpdate(tabYDoc, base64ToBytes(note.yjsState));
        } catch {
          // document.json 是恢复源；Yjs update 损坏时不阻断用户打开文件。
        }
      }
      tabYDocsRef.current.set(tab.id, tabYDoc);
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      clearSelection();
      setToolState('select');
      setPendingPlacement(undefined);
    },
    [clearSelection],
  );

  const openReadTab = useCallback(() => {
    rememberResources(resourceCacheRef.current, document);
    const tab = createTab(cloneDocument(document), 'reader');
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    clearSelection();
    setToolState('select');
    setPendingPlacement(undefined);
  }, [clearSelection, document]);

  const setActivePage = useCallback(
    (pageId: string) => {
      if (!document.pages.some((page) => page.id === pageId)) {
        return;
      }
      updateActiveTab((tab) => ({ ...tab, activePageId: pageId }));
      clearSelection();
      setToolState('select');
      setPendingPlacement(undefined);
    },
    [clearSelection, document.pages, updateActiveTab],
  );

  const addPage = useCallback(() => {
    // 页面增删重排属于文档结构变更，必须用 document scope 同步给所有协作者。
    const id = createId('page');
    updateDocument((current) => {
      const index = current.pages.length + 1;
      const nextPage: NotePage = {
        id,
        title: `第 ${index} 页`,
        width: current.pages[0]?.width ?? 794,
        height: current.pages[0]?.height ?? 1123,
        background: current.pages[0]?.background ?? '#fffaf0',
      };
      return { ...current, pages: [...current.pages, nextPage] };
    }, { collaborationScope: { type: 'document' } });
    updateActiveTab((tab) => ({ ...tab, activePageId: id }));
    clearSelection();
    setToolState('select');
  }, [clearSelection, updateActiveTab, updateDocument]);

  const deletePage = useCallback(
    (pageId: string) => {
      if (document.pages.length <= 1) {
        return;
      }
      updateDocument((current) => {
        const pages = current.pages.filter((page) => page.id !== pageId);
        return {
          ...current,
          pages,
          elements: current.elements.filter((element) => element.pageId !== pageId),
        };
      }, { collaborationScope: { type: 'document' } });
      if (activePageId === pageId) {
        const nextPageId = document.pages.find((page) => page.id !== pageId)?.id;
        updateActiveTab((tab) => ({ ...tab, activePageId: nextPageId ?? document.pages[0].id }));
      }
      clearSelection();
    },
    [activePageId, clearSelection, document.pages, updateActiveTab, updateDocument],
  );

  const reorderPage = useCallback(
    (sourcePageId: string, targetPageId: string) => {
      if (sourcePageId === targetPageId) {
        return;
      }
      updateDocument((current) => {
        const sourceIndex = current.pages.findIndex((page) => page.id === sourcePageId);
        const targetIndex = current.pages.findIndex((page) => page.id === targetPageId);
        if (sourceIndex < 0 || targetIndex < 0) {
          return current;
        }
        const pages = current.pages.slice();
        const [source] = pages.splice(sourceIndex, 1);
        pages.splice(targetIndex, 0, source);
        return { ...current, pages };
      }, { collaborationScope: { type: 'document' } });
      clearSelection();
    },
    [clearSelection, updateDocument],
  );

  const updatePage = useCallback(
    (pageId: string, patch: Partial<NotePage>) => {
      updateDocument((current) => ({
        ...current,
        pages: current.pages.map((page) => (page.id === pageId ? { ...page, ...patch } : page)),
      }), { collaborationScope: { type: 'page', pageId } });
    },
    [updateDocument],
  );

  const renamePage = useCallback(
    (pageId: string, title: string) => {
      const trimmed = title.trim();
      if (trimmed) {
        updatePage(pageId, { title: trimmed });
      }
    },
    [updatePage],
  );

  const selectElement = useCallback(
    (id?: string) => {
      if (activeTabMode !== 'edit') {
        clearSelection();
        return;
      }
      setSelectedElementId(id);
      if (!id) {
        setEditingElementId(undefined);
      }
    },
    [activeTabMode, clearSelection],
  );

  const updateElement = useCallback(
    (id: string, patch: Partial<NoteElement>, options: DocumentUpdateOptions = {}) => {
      // 元素更新先 clamp 到页面内，再判断是否真的变更，减少拖动时的无效历史记录。
      updateDocument((current) => {
        let changed = false;
        const elements = current.elements.map((element) => {
          if (element.id !== id) {
            return element;
          }
          const next = clampElementToPage({ ...element, ...patch }, current.pages);
          if (hasElementChanged(element, next, patch)) {
            changed = true;
            return next;
          }
          return element;
        });
        if (!changed && !options.historyBase) {
          return current;
        }
        return { ...current, elements };
      }, options);
    },
    [updateDocument],
  );

  const addElement = useCallback(
    (type: ElementType, patch: Partial<NoteElement> = {}) => {
      if (activeTabMode !== 'edit') {
        return;
      }
      if (type === 'sticker' && !(patch.assetId ?? toolStyles.sticker.assetId)) {
        return;
      }
      const id = createId('el');
      const isStroke = (type === 'drawing' || type === 'tape') && Boolean(patch.points?.length);
      updateDocument((current) => {
        const maxZIndex = Math.max(0, ...current.elements.map((element) => element.zIndex));
        // 画笔和胶带是后补的批注层，默认总是压到当前页面元素之上，避免被图片或贴纸遮住。
        const zIndex = isStroke ? maxZIndex + 100 : maxZIndex + 10;
        const assetId = patch.assetId ?? (type === 'sticker' ? toolStyles.sticker.assetId : undefined);
        const base: NoteElement = {
          id,
          pageId: activePage.id,
          type,
          x: isStroke ? 0 : 180,
          y: isStroke ? 0 : 180,
          width: isStroke ? activePage.width : type === 'text' ? toolStyles.text.width : type === 'sticker' ? toolStyles.sticker.width : 180,
          height: isStroke ? activePage.height : type === 'text' ? toolStyles.text.height : type === 'sticker' ? toolStyles.sticker.height : 150,
          rotation: 0,
          content: type === 'text' ? '<p>新的文字</p>' : undefined,
          assetId,
          style:
            type === 'text'
              ? {
                  fontSize: toolStyles.text.fontSize,
                  color: toolStyles.text.color,
                  background: toolStyles.text.background,
                  fontFamily: toolStyles.text.fontFamily,
                  borderColor: toolStyles.text.borderColor,
                  borderWidth: toolStyles.text.borderWidth,
                  borderStyle: toolStyles.text.borderStyle,
                  borderRadius: toolStyles.text.borderRadius,
                }
              : type === 'sticker' || type === 'image'
                ? { fit: 'contain' }
              : type === 'tape'
                ? { ...toolStyles.tape }
              : type === 'drawing'
                ? { ...toolStyles.drawing }
                : {},
          ...patch,
          zIndex: isStroke ? Math.max(Number(patch.zIndex ?? 0), zIndex) : Number(patch.zIndex ?? zIndex),
        };
        return {
          ...current,
          elements: [...current.elements, clampElementToPage(base, current.pages)],
        };
      });
      if (!isStroke) {
        setSelectedElementId(id);
        setEditingElementId(type === 'text' ? id : undefined);
        setToolState('select');
      }
    },
    [activePage, activeTabMode, toolStyles, updateDocument],
  );

  const armPlacement = useCallback(
    (placement?: PendingPlacement) => {
      setPendingPlacement(placement);
      if (placement) {
        setToolState(placement.type);
        clearSelection();
      }
    },
    [clearSelection],
  );

  const placePendingElement = useCallback(
    (x: number, y: number) => {
      if (activeTabMode !== 'edit') {
        return;
      }
      const type =
        pendingPlacement?.type ??
        (toolState === 'text' || toolState === 'sticker' || toolState === 'image' ? toolState : undefined);
      if (!type) {
        return;
      }
      const patch = pendingPlacement?.patch ?? {};
      const width = Number(
        patch.width ?? (type === 'text' ? toolStyles.text.width : type === 'sticker' ? toolStyles.sticker.width : 220),
      );
      const height = Number(
        patch.height ?? (type === 'text' ? toolStyles.text.height : type === 'sticker' ? toolStyles.sticker.height : 160),
      );
      if (type === 'sticker' && !(patch.assetId ?? toolStyles.sticker.assetId)) {
        return;
      }
      if (type === 'image' && !patch.assetId) {
        return;
      }
      // 用户点的是希望元素出现的位置，所以用元素中心对齐点击点，同时限制在页面坐标范围内。
      const nextX = Math.max(0, Math.min(activePage.width - width, Math.round(x - width / 2)));
      const nextY = Math.max(0, Math.min(activePage.height - height, Math.round(y - height / 2)));
      addElement(type, { ...patch, x: nextX, y: nextY, width, height });
      setPendingPlacement(undefined);
    },
    [activePage.height, activePage.width, activeTabMode, addElement, pendingPlacement, toolState, toolStyles],
  );

  const deleteElement = useCallback(
    (id: string) => {
      updateDocument((current) => ({
        ...current,
        elements: current.elements.filter((element) => element.id !== id),
      }));
      setSelectedElementId((current) => (current === id ? undefined : current));
      setEditingElementId((current) => (current === id ? undefined : current));
    },
    [updateDocument],
  );

  const deleteSelectedElement = useCallback(() => {
    if (selectedElementId) {
      deleteElement(selectedElementId);
    }
  }, [deleteElement, selectedElementId]);

  const duplicateElement = useCallback(
    (id: string) => {
      const element = document.elements.find((item) => item.id === id);
      if (!element) {
        return;
      }
      const nextId = createId('el');
      updateDocument((current) => ({
        ...current,
        elements: [
          ...current.elements,
          clampElementToPage({
            ...element,
            id: nextId,
            x: element.x + 24,
            y: element.y + 24,
            zIndex: Math.max(0, ...current.elements.map((item) => item.zIndex)) + 10,
          }, current.pages),
        ],
      }));
      setSelectedElementId(nextId);
      setEditingElementId(undefined);
    },
    [document.elements, updateDocument],
  );

  const renameElement = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      const element = document.elements.find((item) => item.id === id);
      updateElement(id, { style: { ...(element?.style ?? {}), displayName: trimmed } });
    },
    [document.elements, updateElement],
  );

  const moveElementLayer = useCallback(
    (id: string, direction: 'up' | 'down' | 'front' | 'back') => {
      // 图层操作只在当前页元素之间调整 zIndex，不影响其他页面的元素排序。
      updateDocument((current) => {
        const pageElements = current.elements
          .filter((element) => element.pageId === activePageId)
          .slice()
          .sort((first, second) => first.zIndex - second.zIndex);
        const index = pageElements.findIndex((element) => element.id === id);
        if (index < 0) {
          return current;
        }
        const nextZ = new Map(current.elements.map((element) => [element.id, element.zIndex]));
        if (direction === 'front') {
          nextZ.set(id, Math.max(...pageElements.map((element) => element.zIndex)) + 10);
        } else if (direction === 'back') {
          nextZ.set(id, Math.min(...pageElements.map((element) => element.zIndex)) - 10);
        } else {
          const swapIndex = direction === 'up' ? index + 1 : index - 1;
          if (swapIndex < 0 || swapIndex >= pageElements.length) {
            return current;
          }
          nextZ.set(id, pageElements[swapIndex].zIndex);
          nextZ.set(pageElements[swapIndex].id, pageElements[index].zIndex);
        }
        return {
          ...current,
          elements: current.elements.map((element) => ({ ...element, zIndex: nextZ.get(element.id) ?? element.zIndex })),
        };
      });
    },
    [activePageId, updateDocument],
  );

  const reorderElementLayer = useCallback(
    (sourceElementId: string, targetElementId: string) => {
      if (sourceElementId === targetElementId) {
        return;
      }
      updateDocument((current) => {
        const ordered = current.elements
          .filter((element) => element.pageId === activePageId)
          .slice()
          .sort((first, second) => second.zIndex - first.zIndex);
        const sourceIndex = ordered.findIndex((element) => element.id === sourceElementId);
        const targetIndex = ordered.findIndex((element) => element.id === targetElementId);
        if (sourceIndex < 0 || targetIndex < 0) {
          return current;
        }
        const [source] = ordered.splice(sourceIndex, 1);
        ordered.splice(targetIndex, 0, source);
        const nextZ = new Map<string, number>();
        ordered.forEach((element, index) => {
          // 图层列表是从上到下展示；zIndex 越大越靠上，因此按列表顺序重新分配稳定间隔。
          nextZ.set(element.id, (ordered.length - index) * 10);
        });
        let changed = false;
        const elements = current.elements.map((element) => {
          const zIndex = nextZ.get(element.id);
          if (zIndex === undefined || zIndex === element.zIndex) {
            return element;
          }
          changed = true;
          return { ...element, zIndex };
        });
        return changed ? { ...current, elements } : current;
      });
    },
    [activePageId, updateDocument],
  );

  const undo = useCallback(() => {
    // 撤销/重做恢复的是持久化文档快照；选择状态、工具状态和缩放不进入历史。
    updateActiveTab((tab) => {
      if (tab.mode !== 'edit') {
        return tab;
      }
      const history = tab.history ?? { past: [], future: [] };
      const previous = history.past[history.past.length - 1];
      if (!previous) {
        return tab;
      }
      pendingCollaborationScopeRef.current = { type: 'document' };
      rememberResources(resourceCacheRef.current, tab.document);
      const normalized = normalizeDocument(hydrateResourcesFromCache(previous, resourceCacheRef.current));
      rememberResources(resourceCacheRef.current, normalized);
      return {
        ...tab,
        title: normalized.title,
        document: normalized,
        activePageId: normalized.pages.some((page) => page.id === tab.activePageId) ? tab.activePageId : normalized.pages[0]?.id ?? 'page-1',
        history: {
          past: history.past.slice(0, -1),
          future: [cloneDocumentForHistory(tab.document), ...history.future].slice(0, maxHistorySteps),
        },
      };
    });
    clearSelection();
  }, [clearSelection, updateActiveTab]);

  const redo = useCallback(() => {
    updateActiveTab((tab) => {
      if (tab.mode !== 'edit') {
        return tab;
      }
      const history = tab.history ?? { past: [], future: [] };
      const next = history.future[0];
      if (!next) {
        return tab;
      }
      pendingCollaborationScopeRef.current = { type: 'document' };
      rememberResources(resourceCacheRef.current, tab.document);
      const normalized = normalizeDocument(hydrateResourcesFromCache(next, resourceCacheRef.current));
      rememberResources(resourceCacheRef.current, normalized);
      return {
        ...tab,
        title: normalized.title,
        document: normalized,
        activePageId: normalized.pages.some((page) => page.id === tab.activePageId) ? tab.activePageId : normalized.pages[0]?.id ?? 'page-1',
        history: {
          past: [...history.past, cloneDocumentForHistory(tab.document)].slice(-maxHistorySteps),
          future: history.future.slice(1),
        },
      };
    });
    clearSelection();
  }, [clearSelection, updateActiveTab]);

  const addAsset = useCallback(
    (asset: AssetMeta) => {
      updateDocument((current) => {
        const hydrated = hydrateAsset(asset);
        const exists = current.assets.some((item) => item.id === hydrated.id);
        // assets 只保存普通图片素材和背景图；贴纸单独进入 stickers，避免两个面板互相同步。
        return { ...current, assets: exists ? current.assets.map((item) => (item.id === hydrated.id ? hydrated : item)) : [...current.assets, hydrated] };
      });
    },
    [updateDocument],
  );

  const replaceAsset = useCallback(
    (oldId: string, asset: AssetMeta) => {
      updateDocument((current) => {
        const hydrated = hydrateAsset(asset);
        return {
          ...current,
          assets: [...current.assets.filter((item) => item.id !== oldId && item.id !== hydrated.id), hydrated],
          pages: current.pages.map((page) => (page.backgroundAssetId === oldId ? { ...page, backgroundAssetId: hydrated.id } : page)),
          elements: current.elements.map((element) =>
            element.assetId === oldId && element.type === 'image' ? { ...element, assetId: hydrated.id, style: { ...(element.style ?? {}), fit: 'contain' } } : element,
          ),
        };
      }, { collaborationScope: { type: 'document' } });
    },
    [updateDocument],
  );

  const deleteAsset = useCallback(
    (id: string) => {
      updateDocument((current) => ({
        ...current,
        assets: current.assets.filter((asset) => asset.id !== id),
        pages: current.pages.map((page) =>
          page.backgroundAssetId === id
            ? { ...page, backgroundAssetId: '', backgroundFit: 'cover', backgroundCropX: 50, backgroundCropY: 50 }
            : page,
        ),
        elements: current.elements.filter((element) => !(element.type === 'image' && element.assetId === id)),
      }), { collaborationScope: { type: 'document' } });
      setSelectedElementId((current) => {
        const selected = document.elements.find((element) => element.id === current);
        return selected?.type === 'image' && selected.assetId === id ? undefined : current;
      });
    },
    [document.elements, updateDocument],
  );

  const addSticker = useCallback(
    (asset: AssetMeta) => {
      updateDocument((current) => {
        const hydrated = hydrateAsset(asset);
        const exists = current.stickers.some((item) => item.id === hydrated.id);
        return {
          ...current,
          stickers: exists ? current.stickers.map((item) => (item.id === hydrated.id ? hydrated : item)) : [...current.stickers, hydrated],
        };
      });
    },
    [updateDocument],
  );

  const replaceSticker = useCallback(
    (oldId: string, asset: AssetMeta) => {
      updateDocument((current) => {
        const hydrated = hydrateAsset(asset);
        return {
          ...current,
          stickers: [...current.stickers.filter((item) => item.id !== oldId && item.id !== hydrated.id), hydrated],
          elements: current.elements.map((element) =>
            element.assetId === oldId && element.type === 'sticker' ? { ...element, assetId: hydrated.id, style: { ...(element.style ?? {}), fit: 'contain' } } : element,
          ),
        };
      }, { collaborationScope: { type: 'document' } });
    },
    [updateDocument],
  );

  const deleteSticker = useCallback(
    (id: string) => {
      updateDocument((current) => ({
        ...current,
        stickers: current.stickers.filter((asset) => asset.id !== id),
        elements: current.elements.filter((element) => !(element.type === 'sticker' && element.assetId === id)),
      }), { collaborationScope: { type: 'document' } });
    },
    [updateDocument],
  );

  const addFont = useCallback(
    (font: AssetMeta) => {
      updateDocument((current) => {
        const hydrated = hydrateAsset(font);
        const exists = current.fonts.some((item) => item.id === hydrated.id);
        return { ...current, fonts: exists ? current.fonts.map((item) => (item.id === hydrated.id ? hydrated : item)) : [...current.fonts, hydrated] };
      });
    },
    [updateDocument],
  );

  const createPackage = useCallback((): NotePackage => {
    const update = Y.encodeStateAsUpdate(activeYDoc);
    const now = new Date().toISOString();
    const normalizedDocument = normalizeDocument({ ...document, updatedAt: now });
    return {
      manifest: {
        formatVersion: currentFormatVersion,
        appVersion: '0.1.0',
        title: normalizedDocument.title,
        createdAt: normalizedDocument.createdAt,
        updatedAt: now,
        documentPath: 'document.json',
        yjsStatePath: 'yjs/update.bin',
        assets: normalizedDocument.assets.map(stripTransientAssetData),
        stickers: normalizedDocument.stickers.map(stripTransientAssetData),
        fonts: normalizedDocument.fonts.map(stripTransientAssetData),
      },
      document: {
        ...normalizedDocument,
        assets: normalizedDocument.assets.map(stripTransientAssetData),
        stickers: normalizedDocument.stickers.map(stripTransientAssetData),
        fonts: normalizedDocument.fonts.map(stripTransientAssetData),
      },
      yjsState: bytesToBase64(update),
      assets: normalizedDocument.assets,
      stickers: normalizedDocument.stickers,
      fonts: normalizedDocument.fonts,
      thumbnail: '',
    };
  }, [activeYDoc, document]);

  const createNewDocument = useCallback(async () => {
    try {
      const note = (await DocumentService.NewDocument()) as NotePackage;
      loadPackage(note);
    } catch {
      const tab = createTab(createSeedDocument(), 'edit');
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      clearSelection();
    }
  }, [clearSelection, loadPackage]);

  const value = useMemo<DocumentContextValue>(
    () => ({
      tabs,
      activeTabId,
      activeTabMode,
      document,
      activePageId,
      activePage,
      selectedElementId,
      selectedElement,
      editingElementId,
      zoom,
      tool: toolState,
      toolStyles,
      pendingPlacement,
      yDoc: activeYDoc,
      setZoom,
      setTool,
      updateToolStyle,
      switchTab,
      closeTab,
      renameTab,
      openReadTab,
      setActivePage,
      addPage,
      deletePage,
      reorderPage,
      updatePage,
      renamePage,
      selectElement,
      startEditing: (id: string) => {
        if (activeTabMode !== 'edit') {
          return;
        }
        setSelectedElementId(id);
        setEditingElementId(id);
        setToolState('select');
      },
      stopEditing: () => setEditingElementId(undefined),
      armPlacement,
      placePendingElement,
      replaceDocument,
      loadPackage,
      createPackage,
      createNewDocument,
      updateElement,
      addElement,
      deleteElement,
      deleteSelectedElement,
      duplicateElement,
      renameElement,
      moveElementLayer,
      reorderElementLayer,
      undo,
      redo,
      canUndo,
      canRedo,
      addAsset,
      replaceAsset,
      deleteAsset,
      addSticker,
      replaceSticker,
      deleteSticker,
      addFont,
    }),
    [
      activePage,
      activePageId,
      activeTabId,
      activeTabMode,
      activeYDoc,
      addAsset,
      addElement,
      addFont,
      addPage,
      addSticker,
      armPlacement,
      closeTab,
      canRedo,
      canUndo,
      createNewDocument,
      createPackage,
      deleteElement,
      deletePage,
      reorderPage,
      deleteSelectedElement,
      deleteAsset,
      deleteSticker,
      document,
      duplicateElement,
      editingElementId,
      loadPackage,
      moveElementLayer,
      openReadTab,
      pendingPlacement,
      placePendingElement,
      redo,
      renameElement,
      renamePage,
      renameTab,
      reorderElementLayer,
      replaceDocument,
      replaceAsset,
      replaceSticker,
      selectElement,
      selectedElement,
      selectedElementId,
      setActivePage,
      setTool,
      switchTab,
      tabs,
      toolStyles,
      toolState,
      undo,
      updateElement,
      updatePage,
      updateToolStyle,
      zoom,
    ],
  );

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocument() {
  const context = useContext(DocumentContext);
  if (!context) {
    throw new Error('useDocument must be used inside DocumentProvider');
  }
  return context;
}

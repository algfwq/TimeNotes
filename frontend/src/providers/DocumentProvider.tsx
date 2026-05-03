import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { DocumentService } from '../../bindings/changeme';
import { base64ToBytes, bytesToBase64 } from '../lib/base64';
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
  updateElement: (id: string, patch: Partial<NoteElement>) => void;
  addElement: (type: ElementType, patch?: Partial<NoteElement>) => void;
  deleteElement: (id: string) => void;
  deleteSelectedElement: () => void;
  duplicateElement: (id: string) => void;
  renameElement: (id: string, title: string) => void;
  moveElementLayer: (id: string, direction: 'up' | 'down' | 'front' | 'back') => void;
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
const maxHistorySteps = 80;

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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampElementToPage(element: NoteElement, pages: NotePage[]): NoteElement {
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

export function DocumentProvider({ children }: { children: React.ReactNode }) {
  const yDocRef = useRef(new Y.Doc());
  const resourceCacheRef = useRef(new Map<string, AssetMeta>());
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
  const canUndo = Boolean(activeTab.history?.past.length);
  const canRedo = Boolean(activeTab.history?.future.length);

  useEffect(() => {
    rememberResources(resourceCacheRef.current, document);
  }, [document]);

  const syncToYjs = useCallback((nextDocument: NoteDocument) => {
    const snapshotMap = yDocRef.current.getMap('snapshot');
    yDocRef.current.transact(() => {
      snapshotMap.set('document', nextDocument);
    }, localOrigin);
  }, []);

  useEffect(() => {
    syncToYjs(document);
  }, [document, syncToYjs]);

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
    (updater: (current: NoteDocument) => NoteDocument) => {
      updateActiveTab((tab) => {
        if (tab.mode !== 'edit') {
          return tab;
        }
        rememberResources(resourceCacheRef.current, tab.document);
        const next = normalizeDocument({ ...updater(tab.document), updatedAt: new Date().toISOString() });
        rememberResources(resourceCacheRef.current, next);
        const history = tab.history ?? { past: [], future: [] };
        return {
          ...tab,
          title: next.title,
          document: next,
          activePageId: next.pages.some((page) => page.id === tab.activePageId) ? tab.activePageId : next.pages[0]?.id ?? 'page-1',
          // 文档级撤销只记录持久化模型，不记录选择框、缩放、滚动等临时 UI 状态。
          history: { past: [...history.past, cloneDocumentForHistory(tab.document)].slice(-maxHistorySteps), future: [] },
        };
      });
    },
    [updateActiveTab],
  );

  useEffect(() => {
    const snapshotMap = yDocRef.current.getMap('snapshot');
    const observer = (events: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
      if (transaction.origin === localOrigin || !events.keysChanged.has('document')) {
        return;
      }
      const nextDocument = snapshotMap.get('document') as NoteDocument | undefined;
      if (!nextDocument) {
        return;
      }
      updateActiveTab((tab) => {
        if (tab.mode !== 'edit') {
          return tab;
        }
        const normalized = normalizeDocument(nextDocument);
        return { ...tab, title: normalized.title, document: normalized };
      });
    };
    snapshotMap.observe(observer);
    return () => snapshotMap.unobserve(observer);
  }, [updateActiveTab]);

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
      const normalized = normalizeDocument(note.document, note.assets ?? [], note.stickers ?? [], note.fonts ?? []);
      rememberResources(resourceCacheRef.current, normalized);
      if (note.yjsState) {
        try {
          Y.applyUpdate(yDocRef.current, base64ToBytes(note.yjsState));
        } catch {
          // document.json 是恢复源；Yjs update 损坏时不阻断用户打开文件。
        }
      }
      const tab = createTab(normalized, 'edit', sourcePath);
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
    });
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
      });
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
      });
      clearSelection();
    },
    [clearSelection, updateDocument],
  );

  const updatePage = useCallback(
    (pageId: string, patch: Partial<NotePage>) => {
      updateDocument((current) => ({
        ...current,
        pages: current.pages.map((page) => (page.id === pageId ? { ...page, ...patch } : page)),
      }));
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
    (id: string, patch: Partial<NoteElement>) => {
      updateDocument((current) => ({
        ...current,
        elements: current.elements.map((element) => (element.id === id ? clampElementToPage({ ...element, ...patch }, current.pages) : element)),
      }));
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
      const width = Number(patch.width ?? (type === 'text' ? toolStyles.text.width : type === 'sticker' ? toolStyles.sticker.width : 220));
      const height = Number(patch.height ?? (type === 'text' ? toolStyles.text.height : type === 'sticker' ? toolStyles.sticker.height : 160));
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

  const undo = useCallback(() => {
    updateActiveTab((tab) => {
      if (tab.mode !== 'edit') {
        return tab;
      }
      const history = tab.history ?? { past: [], future: [] };
      const previous = history.past[history.past.length - 1];
      if (!previous) {
        return tab;
      }
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
      });
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
      }));
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
      });
    },
    [updateDocument],
  );

  const deleteSticker = useCallback(
    (id: string) => {
      updateDocument((current) => ({
        ...current,
        stickers: current.stickers.filter((asset) => asset.id !== id),
        elements: current.elements.filter((element) => !(element.type === 'sticker' && element.assetId === id)),
      }));
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
    const update = Y.encodeStateAsUpdate(yDocRef.current);
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
  }, [document]);

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
      yDoc: yDocRef.current,
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

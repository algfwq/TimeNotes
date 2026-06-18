import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Button, Slider, Typography } from '@douyinfe/semi-ui';
import { IconChevronLeft, IconChevronRight, IconRefresh } from '@douyinfe/semi-icons';
import type { AssetMeta, NoteElement, NotePage, ResourceTransferProgress } from '../types';
import { findClosestLinkHref, openExternalLink } from '../lib/externalLinks';
import { assetDataUrl, mergeAssetWithCache } from '../lib/files';
import { useDocument } from '../providers/DocumentProvider';
import { resourceProgressKey, useResourceProgressMap } from '../providers/ResourceProgressStore';
import { PageBackground } from './PageBackground';
import { AudioElement } from './elements/AudioElement';
import { VideoElement } from './elements/VideoElement';
import { ModelElement } from './elements/ModelElement';
import { CodeBlockPreview } from './elements/CodeBlockElement';

const defaultInlineCodeFontFamily = '"Cascadia Code", "Fira Code", Consolas, "SFMono-Regular", monospace';
const SPINE_WIDTH = 40;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.4;
const FLIP_DURATION = 680;

interface SpreadPages {
  left: NotePage | null;
  right: NotePage | null;
}

interface FlipState {
  direction: 'next' | 'prev';
  toIndex: number;
  bgLeft: NotePage | null;
  bgRight: NotePage | null;
  sheetFront: NotePage | null;
  sheetBack: NotePage | null;
}

export function ReadOnlyViewer() {
  const { document, activePage, setActivePage, getResourceAsset } = useDocument();
  const resourceProgress = useResourceProgressMap();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const sidesheetOpenRef = useRef(false);

  const [scale, setScale] = useState(0.8);
  const [fitScale, setFitScale] = useState(0.8);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spreadIndex, setSpreadIndex] = useState(0);
  const [flip, setFlip] = useState<FlipState | null>(null);

  const firstPage = document.pages[0];
  const samplePage = firstPage ?? ({ width: 800, height: 1100 } as NotePage);

  const isEvenPages = document.pages.length % 2 === 0;
  const totalSpreads = isEvenPages
    ? Math.ceil(document.pages.length / 2)
    : Math.ceil((document.pages.length + 1) / 2);

  const getSpreadPages = useCallback(
    (s: number): SpreadPages => {
      if (isEvenPages) {
        const leftIdx = s * 2;
        const rightIdx = s * 2 + 1;
        return {
          left: leftIdx < document.pages.length ? document.pages[leftIdx] : null,
          right: rightIdx < document.pages.length ? document.pages[rightIdx] : null,
        };
      }
      const leftIdx = s * 2 - 1;
      const rightIdx = s * 2;
      return {
        left: leftIdx >= 0 && leftIdx < document.pages.length ? document.pages[leftIdx] : null,
        right: rightIdx >= 0 && rightIdx < document.pages.length ? document.pages[rightIdx] : null,
      };
    },
    [document.pages, isEvenPages],
  );

  const currentSpread = getSpreadPages(spreadIndex);

  useLayoutEffect(() => {
    const updateFit = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pw = samplePage.width;
      const ph = samplePage.height;
      const combinedW = pw * 2 + SPINE_WIDTH + 80;
      const next = Math.min((rect.width - 60) / combinedW, (rect.height - 130) / ph, 1.0);
      const normalized = Math.max(0.28, Number(next.toFixed(2)));
      setFitScale(normalized);
      setScale((current) => (current === fitScale ? normalized : current));
    };
    updateFit();
    window.addEventListener('resize', updateFit);
    return () => window.removeEventListener('resize', updateFit);
  }, [samplePage.height, samplePage.width, fitScale]);

  useEffect(() => {
    const refresh = () => {
      const node = window.document.querySelector<HTMLElement>('.semi-sidesheet');
      if (!node) {
        sidesheetOpenRef.current = false;
        return;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      sidesheetOpenRef.current =
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && (rect.width > 0 || rect.height > 0);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(window.document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (spreadIndex >= totalSpreads) {
      setSpreadIndex(Math.max(0, totalSpreads - 1));
    }
  }, [totalSpreads, spreadIndex]);

  useEffect(() => {
    if (flip) return;
    const idx = Math.max(0, document.pages.findIndex((p) => p.id === activePage.id));
    const even = document.pages.length % 2 === 0;
    const spread = idx < 0 ? 0 : even ? Math.floor(idx / 2) : Math.floor((idx + 1) / 2);
    if (spread !== spreadIndex) {
      setSpreadIndex(spread);
    }
  }, [activePage.id, document.pages, spreadIndex, flip]);

  const commitFlip = useCallback(
    (target: number) => {
      const spread = getSpreadPages(target);
      const active = spread.right ?? spread.left;
      if (active) setActivePage(active.id);
      setSpreadIndex(target);
      setPan({ x: 0, y: 0 });
      setFlip(null);
    },
    [getSpreadPages, setActivePage],
  );

  const goToSpread = useCallback(
    (target: number) => {
      if (flip) return;
      if (target < 0 || target >= totalSpreads) return;
      if (target === spreadIndex) return;
      const direction: FlipState['direction'] = target > spreadIndex ? 'next' : 'prev';
      const from = getSpreadPages(spreadIndex);
      const to = getSpreadPages(target);
      setFlip(
        direction === 'next'
          ? {
              direction,
              toIndex: target,
              bgLeft: from.left,
              bgRight: to.right,
              sheetFront: from.right,
              sheetBack: to.left,
            }
          : {
              direction,
              toIndex: target,
              bgLeft: to.left,
              bgRight: from.right,
              sheetFront: from.left,
              sheetBack: to.right,
            },
      );
    },
    [flip, totalSpreads, spreadIndex, getSpreadPages],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToSpread(spreadIndex + 1);
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToSpread(spreadIndex - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToSpread, spreadIndex]);

  const startPan = (e: ReactPointerEvent) => {
    if (sidesheetOpenRef.current) return;
    e.preventDefault();
    panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const movePan = (e: ReactPointerEvent) => {
    if (sidesheetOpenRef.current) return;
    if (!panStartRef.current) return;
    setPan({
      x: panStartRef.current.panX + e.clientX - panStartRef.current.x,
      y: panStartRef.current.panY + e.clientY - panStartRef.current.y,
    });
  };

  const endPan = () => {
    panStartRef.current = null;
  };

  const handleWheel = (e: ReactWheelEvent) => {
    if (sidesheetOpenRef.current) return;
    e.preventDefault();
    setScale((s) => Number(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s + (e.deltaY > 0 ? -0.06 : 0.06))).toFixed(2)));
  };

  const pageElementsMap = useMemo(() => {
    const map = new Map<string, NoteElement[]>();
    for (const el of document.elements) {
      const list = map.get(el.pageId);
      if (list) {
        list.push(el);
      } else {
        map.set(el.pageId, [el]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.zIndex - b.zIndex);
    }
    return map;
  }, [document.elements]);

  const renderPageContent = (page: NotePage | null) => {
    if (!page) return null;
    const elements = pageElementsMap.get(page.id) ?? [];
    return (
      <ReadOnlyPage
        page={page}
        elements={elements}
        assets={document.assets}
        stickers={document.stickers}
        audios={document.audios}
        videos={document.videos}
        models={document.models}
        resourceProgress={resourceProgress}
        getResourceAsset={getResourceAsset}
      />
    );
  };

  const displayedLeft = flip ? flip.bgLeft : currentSpread.left;
  const displayedRight = flip ? flip.bgRight : currentSpread.right;
  const firstIdx = currentSpread.left ? document.pages.indexOf(currentSpread.left) : currentSpread.right ? document.pages.indexOf(currentSpread.right) : -1;
  const lastIdx = currentSpread.right ? document.pages.indexOf(currentSpread.right) : currentSpread.left ? document.pages.indexOf(currentSpread.left) : -1;

  const atStart = spreadIndex === 0;
  const atEnd = spreadIndex >= totalSpreads - 1;

  const leftSlotWidth = displayedLeft?.width ?? samplePage.width;

  return (
    <div ref={wrapRef} className="reading-mode-stage flex h-full min-h-0 flex-col">
      <div className="book-toolbar flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div>
          <Typography.Text strong>{document.title}</Typography.Text>
          <span className="ml-3 text-xs text-black/45">
            {firstIdx >= 0 ? `${firstIdx + 1}${lastIdx !== firstIdx ? `-${lastIdx + 1}` : ''}` : '0'} / {document.pages.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="small" theme="borderless" icon={<IconChevronLeft />} disabled={atStart || Boolean(flip)} onClick={() => goToSpread(spreadIndex - 1)} />
          <span className="mx-1 min-w-[4ch] text-center text-xs text-black/55 tabular-nums">
            {spreadIndex + 1}/{totalSpreads}
          </span>
          <Button size="small" theme="borderless" icon={<IconChevronRight />} disabled={atEnd || Boolean(flip)} onClick={() => goToSpread(spreadIndex + 1)} />
        </div>
        <div className="flex w-64 items-center gap-3">
          <span className="shrink-0 text-xs text-black/55">{Math.round(scale * 100)}%</span>
          <Slider value={scale * 100} min={25} max={240} step={5} onChange={(v) => setScale(Number(v) / 100)} />
          <Button
            size="small"
            theme="borderless"
            icon={<IconRefresh />}
            onClick={() => {
              setScale(fitScale);
              setPan({ x: 0, y: 0 });
            }}
          />
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ cursor: 'grab' }}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerLeave={endPan}
        onWheel={handleWheel}
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          }}
        >
          <div className="book-flip-perspective relative flex">
            <BookPageSlot page={displayedLeft} content={renderPageContent(displayedLeft)} defaultWidth={samplePage.width} defaultHeight={samplePage.height} />
            <div className="book-spine flex-shrink-0" style={{ width: SPINE_WIDTH }} />
            <BookPageSlot page={displayedRight} content={renderPageContent(displayedRight)} defaultWidth={samplePage.width} defaultHeight={samplePage.height} />
            {flip ? (
              <FlipSheet
                flip={flip}
                leftSlotWidth={leftSlotWidth}
                spineWidth={SPINE_WIDTH}
                sampleWidth={samplePage.width}
                sampleHeight={samplePage.height}
                durationMs={FLIP_DURATION}
                renderContent={renderPageContent}
                onDone={() => commitFlip(flip.toIndex)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function FlipSheet({
  flip,
  leftSlotWidth,
  spineWidth,
  sampleWidth,
  sampleHeight,
  durationMs,
  renderContent,
  onDone,
}: {
  flip: FlipState;
  leftSlotWidth: number;
  spineWidth: number;
  sampleWidth: number;
  sampleHeight: number;
  durationMs: number;
  renderContent: (page: NotePage | null) => React.ReactNode;
  onDone: () => void;
}) {
  const doneRef = useRef(false);
  const isNext = flip.direction === 'next';
  const sheetW = flip.sheetFront?.width ?? flip.sheetBack?.width ?? sampleWidth;
  const sheetH = flip.sheetFront?.height ?? flip.sheetBack?.height ?? sampleHeight;
  const sheetLeft = isNext ? leftSlotWidth + spineWidth : 0;
  const transformOrigin = isNext ? `${-spineWidth / 2}px center` : `calc(100% + ${spineWidth / 2}px) center`;

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  useEffect(() => {
    doneRef.current = false;
    const timer = window.setTimeout(finish, durationMs + 160);
    return () => window.clearTimeout(timer);
  }, [finish, durationMs]);

  const renderFace = (page: NotePage | null) =>
    page ? renderContent(page) : <div className="book-blank-page" style={{ width: sheetW, height: sheetH, background: '#fffaf0' }}><BlankPageLines pageWidth={sheetW} pageHeight={sheetH} /></div>;

  const frontShade = isNext
    ? 'linear-gradient(90deg, rgba(0,0,0,0.34), rgba(0,0,0,0) 58%)'
    : 'linear-gradient(270deg, rgba(0,0,0,0.34), rgba(0,0,0,0) 58%)';
  const backShade = isNext
    ? 'linear-gradient(270deg, rgba(0,0,0,0.30), rgba(0,0,0,0) 58%)'
    : 'linear-gradient(90deg, rgba(0,0,0,0.30), rgba(0,0,0,0) 58%)';

  return (
    <div
      className={`book-flip-sheet ${isNext ? 'book-flip-sheet--next' : 'book-flip-sheet--prev'}`}
      style={{ left: sheetLeft, width: sheetW, height: sheetH, transformOrigin, animationDuration: `${durationMs}ms` }}
      onAnimationEnd={(event) => {
        if (event.animationName.startsWith('bookFlip')) finish();
      }}
    >
      <div className="book-flip-face book-flip-face--front" style={{ width: sheetW, height: sheetH }}>
        {renderFace(flip.sheetFront)}
        <div className="book-flip-shade book-flip-shade--out" style={{ backgroundImage: frontShade, animationDuration: `${durationMs}ms` }} />
      </div>
      <div className="book-flip-face book-flip-face--back" style={{ width: sheetW, height: sheetH }}>
        {renderFace(flip.sheetBack)}
        <div className="book-flip-shade book-flip-shade--in" style={{ backgroundImage: backShade, animationDuration: `${durationMs}ms` }} />
      </div>
    </div>
  );
}

function BookPageSlot({
  page,
  content,
  defaultWidth,
  defaultHeight,
}: {
  page: NotePage | null;
  content: React.ReactNode;
  defaultWidth: number;
  defaultHeight: number;
}) {
  const w = page?.width ?? defaultWidth;
  const h = page?.height ?? defaultHeight;
  if (content) {
    return <div className="book-page shadow-page flex-shrink-0">{content}</div>;
  }
  return (
    <div className="book-page book-blank-page flex-shrink-0 shadow-page" style={{ width: w, height: h, background: '#fffaf0' }}>
      <BlankPageLines pageWidth={w} pageHeight={h} />
    </div>
  );
}

function BlankPageLines({ pageWidth, pageHeight }: { pageWidth: number; pageHeight: number }) {
  const lines: { y: number }[] = [];
  const lineSpacing = 34;
  const startY = 64;
  for (let y = startY; y < pageHeight - 32; y += lineSpacing) {
    lines.push({ y });
  }
  const marginLeft = Math.round(pageWidth * 0.07);
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${pageWidth} ${pageHeight}`} width={pageWidth} height={pageHeight}>
      <line x1={marginLeft - 6} y1={42} x2={marginLeft - 6} y2={pageHeight - 42} stroke="rgba(189,79,79,0.22)" strokeWidth={1} />
      {lines.map((l) => (
        <line key={l.y} x1={marginLeft} y1={l.y} x2={pageWidth - marginLeft * 0.6} y2={l.y} stroke="rgba(0,0,0,0.10)" strokeWidth={0.5} />
      ))}
    </svg>
  );
}

function ReadOnlyPage({
  page,
  elements,
  assets,
  stickers,
  audios,
  videos,
  models,
  resourceProgress,
  getResourceAsset,
}: {
  page: NotePage;
  elements: NoteElement[];
  assets: AssetMeta[];
  stickers: AssetMeta[];
  audios: AssetMeta[];
  videos: AssetMeta[];
  models: AssetMeta[];
  resourceProgress: Record<string, ResourceTransferProgress>;
  getResourceAsset: (id?: string) => AssetMeta | undefined;
}) {
  const elementAssets = [...assets, ...stickers, ...audios, ...videos, ...models];
  return (
    <main className="relative overflow-hidden" style={{ width: page.width, height: page.height, background: page.background }}>
      <PageBackground page={page} assets={assets} />
      <PaperTexture page={page} hasImage={Boolean(page.backgroundAssetId)} />
      {elements.map((element) => (
        <ReadOnlyElement key={element.id} element={element} assets={elementAssets} page={page} resourceProgress={resourceProgress} getResourceAsset={getResourceAsset} />
      ))}
    </main>
  );
}

function ReadOnlyElement({
  element,
  assets,
  page,
  resourceProgress,
  getResourceAsset,
}: {
  element: NoteElement;
  assets: AssetMeta[];
  page: NotePage;
  resourceProgress: Record<string, ResourceTransferProgress>;
  getResourceAsset: (id?: string) => AssetMeta | undefined;
}) {
  const style = element.style ?? {};
  const handleLinkPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (findClosestLinkHref(event.target)) {
      event.stopPropagation();
    }
  };
  const handleLinkClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const href = findClosestLinkHref(event.target);
    if (!href) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void openExternalLink(href);
  };
  if ((element.type === 'drawing' || element.type === 'tape') && element.points?.length) {
    const stroke = String(style.stroke ?? (element.type === 'tape' ? '#f2cf72' : '#446f64'));
    const strokeWidth = Number(style.strokeWidth ?? (element.type === 'tape' ? 22 : 6));
    const tapePattern = String(style.tapePattern ?? 'dashes');
    const base: CSSProperties = {
      position: 'absolute',
      left: element.x,
      top: element.y,
      width: element.width || page.width,
      height: element.height || page.height,
      zIndex: element.zIndex,
      pointerEvents: 'none',
    };
    return (
      <svg className="overflow-visible" style={base} width={element.width || page.width} height={element.height || page.height}>
        <polyline
          points={pointsToPolyline(element.points)}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={element.type === 'tape' ? 0.86 : 1}
        />
        {element.type === 'tape' && tapePattern === 'dashes' ? (
          <polyline
            points={pointsToPolyline(element.points)}
            fill="none"
            stroke="rgba(255,255,255,.72)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="2 14"
          />
        ) : null}
        {element.type === 'tape' && tapePattern === 'stripe' ? (
          <polyline
            points={pointsToPolyline(element.points)}
            fill="none"
            stroke="rgba(255,255,255,.68)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="12 10"
          />
        ) : null}
        {element.type === 'tape' && tapePattern === 'dots' ? (
          <polyline
            points={pointsToPolyline(element.points)}
            fill="none"
            stroke="rgba(255,255,255,.82)"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="1 14"
          />
        ) : null}
      </svg>
    );
  }

  const base: CSSProperties = {
    position: 'absolute',
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${element.rotation}deg)`,
    zIndex: element.zIndex,
  };

  if (element.type === 'text') {
    return (
      <div
        style={{
          ...base,
          color: String(style.color ?? '#2f2a24'),
          background: String(style.background ?? '') || 'transparent',
          borderWidth: Number(style.borderWidth ?? 0),
          borderStyle: String(style.borderStyle ?? 'solid'),
          borderColor: String(style.borderColor ?? '#2f2a24'),
          borderRadius: Number(style.borderRadius ?? 0),
          fontSize: Number(style.fontSize ?? 22),
          fontFamily: String(style.fontFamily || 'Inter, "Segoe UI", sans-serif'),
          '--timenotes-text-font-family': String(style.fontFamily || 'Inter, "Segoe UI", sans-serif'),
          '--timenotes-inline-code-color': String(style.inlineCodeColor ?? '#8a3f58'),
          '--timenotes-inline-code-font-family': String(style.inlineCodeFontFamily || defaultInlineCodeFontFamily),
          '--timenotes-blockquote-color': String(style.blockquoteColor ?? '#5f5650'),
          '--timenotes-blockquote-font-family': String(style.blockquoteFontFamily || style.fontFamily || 'Inter, "Segoe UI", sans-serif'),
          lineHeight: 1.38,
        } as CSSProperties}
        className="timenotes-rich-text timenotes-text-scroll overflow-auto rounded-[8px] px-4 py-3"
        onPointerDownCapture={handleLinkPointerDown}
        onClickCapture={handleLinkClick}
        onWheel={(event) => event.stopPropagation()}
        dangerouslySetInnerHTML={{ __html: element.content ?? '' }}
      />
    );
  }

  if (element.type === 'code') {
    return (
      <div style={base}>
        <CodeBlockPreview element={element} readOnly />
      </div>
    );
  }

  if (element.type === 'audio') {
    const asset = mergeAssetWithCache(assets.find((item) => item.id === element.assetId), getResourceAsset(element.assetId));
    const progress = element.assetId ? resourceProgress[resourceProgressKey('audios', element.assetId)] : undefined;
    return (
      <div style={base}>
        <AudioElement element={element} asset={asset} progress={progress} readOnly />
      </div>
    );
  }

  if (element.type === 'video') {
    const asset = mergeAssetWithCache(assets.find((item) => item.id === element.assetId), getResourceAsset(element.assetId));
    const progress = element.assetId ? resourceProgress[resourceProgressKey('videos', element.assetId)] : undefined;
    return (
      <div style={base}>
        <VideoElement element={element} asset={asset} progress={progress} readOnly />
      </div>
    );
  }

  if (element.type === 'model') {
    const asset = mergeAssetWithCache(assets.find((item) => item.id === element.assetId), getResourceAsset(element.assetId));
    const cachedAsset = getResourceAsset(element.assetId);
    const progress = element.assetId ? resourceProgress[resourceProgressKey('models', element.assetId)] : undefined;
    return (
      <div style={base}>
        <ModelElement element={element} asset={asset} progress={progress} readOnly cachedAsset={cachedAsset} />
      </div>
    );
  }

  if (element.type === 'image' || element.type === 'sticker') {
    const asset = mergeAssetWithCache(assets.find((item) => item.id === element.assetId), getResourceAsset(element.assetId));
    const src = assetDataUrl(asset);
    const progress = element.assetId ? resourceProgress[resourceProgressKey(element.type === 'sticker' ? 'stickers' : 'assets', element.assetId)] : undefined;
    const showFrame = style.showFrame !== false;
    return src ? (
      <img
        alt=""
        draggable={false}
        src={src}
        style={{
          ...base,
          objectFit: String(style.fit ?? 'contain') as CSSProperties['objectFit'],
          objectPosition: objectPosition(style),
        }}
        className={showFrame ? 'rounded-[8px]' : ''}
      />
    ) : progress ? (
      <div style={base} className="grid place-items-center rounded-[8px] border border-dashed border-black/15 bg-white/70 px-3 text-center">
        <div className="w-full">
          <div className="truncate text-xs text-black/55">{asset?.name || '素材同步中'}</div>
          <div className="mt-1 text-[11px] text-black/45">素材传输中</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
            <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-black/45">{Math.round(progress.progress * 100)}%</div>
        </div>
      </div>
    ) : null;
  }

  return <div style={{ ...base, background: String(style.background ?? '#f7d774') }} />;
}

function pointsToPolyline(points: number[]) {
  const values: string[] = [];
  for (let index = 0; index < points.length - 1; index += 2) {
    values.push(`${points[index]},${points[index + 1]}`);
  }
  return values.join(' ');
}

function objectPosition(style: Record<string, string | number | boolean>) {
  if (style.objectPosition) {
    return String(style.objectPosition);
  }
  if (style.cropX !== undefined || style.cropY !== undefined) {
    return `${Number(style.cropX ?? 50)}% ${Number(style.cropY ?? 50)}%`;
  }
  return '50% 50%';
}

function PaperTexture({ page, hasImage }: { page: NotePage; hasImage: boolean }) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        width: page.width,
        height: page.height,
        background:
          'radial-gradient(circle at 18% 22%, rgba(224,188,134,.18), transparent 26%), radial-gradient(circle at 78% 68%, rgba(126,160,150,.12), transparent 24%), linear-gradient(rgba(0,0,0,.035) 1px, transparent 1px)',
        backgroundSize: 'auto, auto, 100% 32px',
        mixBlendMode: 'multiply',
        opacity: hasImage ? 0.25 : 1,
      }}
    />
  );
}

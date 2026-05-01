import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Button, Pagination, Slider, Typography } from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useDocument } from '../providers/DocumentProvider';
import type { AssetMeta, NoteElement, NotePage } from '../types';
import { PageBackground } from './PageBackground';

export function ReadOnlyViewer() {
  const { document, activePage, setActivePage } = useDocument();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [scale, setScale] = useState(0.8);
  const [fitScale, setFitScale] = useState(0.8);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pageIndex = Math.max(0, document.pages.findIndex((page) => page.id === activePage.id));

  useLayoutEffect(() => {
    const updateScale = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const next = Math.min((rect.width - 80) / activePage.width, (rect.height - 120) / activePage.height, 1.05);
      const normalized = Math.max(0.28, Number(next.toFixed(2)));
      setFitScale(normalized);
      setScale((current) => (current === fitScale ? normalized : current));
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [activePage.height, activePage.width, fitScale]);

  const elements = useMemo(
    () =>
      document.elements
        .filter((element) => element.pageId === activePage.id)
        .slice()
        .sort((first, second) => first.zIndex - second.zIndex),
    [activePage.id, document.elements],
  );

  const changePage = (currentPage: number) => {
    const next = document.pages[currentPage - 1];
    if (next) {
      setActivePage(next.id);
      setPan({ x: 0, y: 0 });
    }
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    panStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) {
      return;
    }
    setPan({
      x: panStartRef.current.panX + event.clientX - panStartRef.current.x,
      y: panStartRef.current.panY + event.clientY - panStartRef.current.y,
    });
  };

  const endPan = () => {
    panStartRef.current = null;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const next = Math.min(2.4, Math.max(0.25, scale + (event.deltaY > 0 ? -0.06 : 0.06)));
    setScale(Number(next.toFixed(2)));
  };

  return (
    <div ref={wrapRef} className="flex h-full min-h-0 flex-col bg-[#e8e2d6]">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-black/10 bg-white/70 px-4 py-2">
        <div>
          <Typography.Text strong>{document.title}</Typography.Text>
          <span className="ml-3 text-xs text-black/45">
            {pageIndex + 1} / {document.pages.length}
          </span>
        </div>
        <Pagination total={document.pages.length} pageSize={1} currentPage={pageIndex + 1} onPageChange={changePage} size="small" />
        <div className="flex w-64 items-center gap-3">
          <span className="shrink-0 text-xs text-black/55">{Math.round(scale * 100)}%</span>
          <Slider value={scale * 100} min={25} max={240} step={5} onChange={(value) => setScale(Number(value) / 100)} />
          <Button
            size="small"
            icon={<IconRefresh />}
            onClick={() => {
              setScale(fitScale);
              setPan({ x: 0, y: 0 });
            }}
          />
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerLeave={endPan}
        onWheel={handleWheel}
      >
        <div
          className="absolute left-1/2 top-8 origin-top shadow-page"
          style={{
            width: activePage.width,
            height: activePage.height,
            transform: `translate(-50%, 0) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          }}
        >
          <ReadOnlyPage page={activePage} elements={elements} assets={document.assets} stickers={document.stickers} />
        </div>
      </div>
    </div>
  );
}

function ReadOnlyPage({
  page,
  elements,
  assets,
  stickers,
}: {
  page: NotePage;
  elements: NoteElement[];
  assets: AssetMeta[];
  stickers: AssetMeta[];
}) {
  const elementAssets = [...assets, ...stickers];
  return (
    <main className="relative overflow-hidden" style={{ width: page.width, height: page.height, background: page.background }}>
      <PageBackground page={page} assets={assets} />
      <PaperTexture page={page} hasImage={Boolean(page.backgroundAssetId)} />
      {elements.map((element) => (
        <ReadOnlyElement key={element.id} element={element} assets={elementAssets} page={page} />
      ))}
    </main>
  );
}

function ReadOnlyElement({
  element,
  assets,
  page,
}: {
  element: NoteElement;
  assets: AssetMeta[];
  page: NotePage;
}) {
  const style = element.style ?? {};
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
          lineHeight: 1.38,
        }}
        className="overflow-hidden rounded-[8px] px-4 py-3"
        dangerouslySetInnerHTML={{ __html: element.content ?? '' }}
      />
    );
  }

  if (element.type === 'image' || element.type === 'sticker') {
    const asset = assets.find((item) => item.id === element.assetId);
    const src = asset?.dataUrl ?? (asset?.dataBase64 ? `data:${asset.mimeType};base64,${asset.dataBase64}` : undefined);
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
        className="rounded-[8px]"
      />
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

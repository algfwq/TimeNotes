import { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { SideSheet } from '@douyinfe/semi-ui';
import * as THREE from 'three';
import type { AssetMeta, NoteElement, ResourceTransferProgress } from '../../types';
import { assetDataUrl, mergeAssetWithCache } from '../../lib/files';
import { isMobile } from '../../lib/platform';

interface ModelElementProps {
  element: NoteElement;
  asset?: AssetMeta;
  progress?: ResourceTransferProgress;
  readOnly?: boolean;
  cachedAsset?: AssetMeta;
}

export function ModelElement({ element, asset, progress, readOnly, cachedAsset }: ModelElementProps) {
  const mergedAsset = useMemo(() => mergeAssetWithCache(asset, cachedAsset), [asset, cachedAsset]);
  const src = useMemo(() => assetDataUrl(mergedAsset), [mergedAsset]);
  const [enlarged, setEnlarged] = useState(false);
  const [hovered, setHovered] = useState(false);

  const stopPointer = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  if (!src) {
    if (progress) {
      return (
        <div className="grid h-full w-full place-items-center rounded-[8px] border border-dashed border-black/15 bg-white/70 px-3 text-center">
          <div className="w-full">
            <div className="truncate text-xs text-black/55">{asset?.name ?? '3D 模型'}</div>
            <div className="mt-1 text-[11px] text-black/45">素材传输中</div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
              <div className="h-full rounded-full bg-[#2f6fed]" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-black/45">{Math.round(progress.progress * 100)}%</div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid h-full w-full place-items-center rounded-[8px] border border-dashed border-black/15 bg-[#e8e2d6]/60 text-center">
        <div>
          <svg className="mx-auto mb-1 text-black/20" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <div className="mt-1 text-[11px] text-black/40">等待模型数据</div>
        </div>
      </div>
    );
  }

  const mobile = isMobile();

  return (
    <>
      <div
        className="timenotes-model-view relative h-full w-full overflow-hidden rounded-[8px]"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onWheel={stopPointer}
      >
        {/* 仅画布区域标记 interactive，便于 Orbit 与选中外壳区分；外壳仍可被 ElementRenderer 选中 */}
        <div
          className="absolute inset-0"
          data-model-interactive
          onPointerDown={stopPointer}
        >
          <Canvas
            flat
            camera={{ position: [3, 2, 5], fov: 45 }}
            gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' }}
            style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #e8e2d6, #d9d3c7)' }}
            dpr={[1, 2]}
          >
              <ambientLight intensity={0.6} />
              <directionalLight position={[5, 8, 5]} intensity={0.8} />
              <directionalLight position={[-3, 2, -3]} intensity={0.3} />
              <Suspense fallback={null}>
                <ModelScene src={src} />
              </Suspense>
              <OrbitControls
                enableDamping={true}
                dampingFactor={0.08}
                minDistance={0.5}
                maxDistance={20}
                makeDefault
              />
            </Canvas>
        </div>
        {/* 桌面：悬停显示；移动端无 hover，始终显示。避开右上角缩放手柄 */}
        {(hovered || mobile) && (
          <button
            type="button"
            data-model-interactive
            className={`absolute z-[90] grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60 ${
              mobile ? 'right-7 top-2' : 'right-2 top-2'
            }`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              setEnlarged(true);
            }}
            title="放大查看"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        )}
      </div>
      <ModelViewerSideSheet
        visible={enlarged}
        src={src}
        name={mergedAsset?.name ?? '3D 模型'}
        onClose={() => setEnlarged(false)}
      />
    </>
  );
}

function ModelScene({ src }: { src: string }) {
  const gltf = useGLTF(src) as { scene: THREE.Group };
  const processedRef = useRef<THREE.Group | null>(null);

  if (processedRef.current) {
    return <primitive object={processedRef.current} />;
  }

  const cloned = gltf.scene.clone(true);
  const box = new THREE.Box3().setFromObject(cloned);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 2.2 / maxDim;
  cloned.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  cloned.scale.setScalar(scale);
  processedRef.current = cloned;

  return <primitive object={cloned} />;
}

function ModelViewerSideSheet({ visible, src, name, onClose }: { visible: boolean; src: string; name: string; onClose: () => void }) {
  const stopWheel = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  return (
    <SideSheet
      visible={visible}
      onCancel={onClose}
      title={
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>{name}</span>
        </div>
      }
      size="large"
      bodyStyle={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}
      style={{ width: 'min(800px, 88vw)' }}
    >
      <div className="flex min-h-0 flex-1" style={{ background: '#1a1a2e' }} onWheel={stopWheel}>
        <Canvas
          camera={{ position: [4, 3, 6], fov: 40 }}
          gl={{ antialias: true, alpha: false, preserveDrawingBuffer: false }}
          style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, background: 'linear-gradient(135deg, #16213e 0%, #1a1a2e 50%, #0f3460 100%)' }}
          dpr={[1, 1.5]}
        >
          <ambientLight intensity={0.5} />
          <directionalLight position={[6, 8, 6]} intensity={0.9} />
          <directionalLight position={[-4, 2, -5]} intensity={0.4} />
          <hemisphereLight args={['#b1e1ff', '#4a3728', 0.3]} />
          <Suspense fallback={null}>
            <SideSheetModelScene src={src} />
          </Suspense>
          <OrbitControls
            enableDamping={false}
            minDistance={0.3}
            maxDistance={30}
            makeDefault
          />
        </Canvas>
      </div>
    </SideSheet>
  );
}

function SideSheetModelScene({ src }: { src: string }) {
  const gltf = useGLTF(src) as { scene: THREE.Group };
  const processedRef = useRef<THREE.Group | null>(null);

  if (processedRef.current) {
    return <primitive object={processedRef.current} />;
  }

  const cloned = gltf.scene.clone(true);
  const box = new THREE.Box3().setFromObject(cloned);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 2.5 / maxDim;
  cloned.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  cloned.scale.setScalar(scale);
  processedRef.current = cloned;

  return <primitive object={cloned} />;
}

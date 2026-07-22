import { useEffect, useRef, useState } from 'react';
import { Button, Cropper, Modal, Slider, Typography } from '@douyinfe/semi-ui';
import { isMobile } from '../lib/platform';

export function ImageCropModal({
  title,
  visible,
  src,
  aspectRatio,
  onClose,
  onApply,
}: {
  title: string;
  visible: boolean;
  src?: string;
  aspectRatio?: number;
  onClose: () => void;
  onApply: (dataUrl: string, size: { width: number; height: number; aspectRatio: number }) => void;
}) {
  const cropperRef = useRef<any>(null);
  const cropShellRef = useRef<HTMLDivElement | null>(null);
  const [rotate, setRotate] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);
  const mobile = isMobile();

  useEffect(() => {
    if (!visible) {
      setReady(false);
      return;
    }
    setRotate(0);
    setZoom(1);
    // Semi Cropper 需要真实可测量的容器；Modal 动画刚开始时直接挂载会拿到空 ref。
    const timer = window.setTimeout(() => setReady(true), 120);
    return () => window.clearTimeout(timer);
  }, [visible, src]);

  // Semi Cropper 只监听 mouse*；Android/iOS 触控不会触发拖拽/缩放框。
  // 仅在移动端把单指 touch 桥成 MouseEvent，桌面仍走原生鼠标逻辑，避免双重事件。
  useEffect(() => {
    if (!ready || !mobile || !visible) {
      return;
    }
    const root = cropShellRef.current;
    if (!root) {
      return;
    }

    let activeTouchId: number | null = null;
    let lastTarget: EventTarget | null = null;

    const dispatchMouse = (type: string, touch: Touch, target: EventTarget | null) => {
      const el = (target instanceof Element ? target : root) as Element;
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.screenX,
        screenY: touch.screenY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
      });
      el.dispatchEvent(event);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || activeTouchId !== null) {
        return;
      }
      const touch = event.touches[0];
      const target = event.target;
      if (!(target instanceof Element) || !root.contains(target)) {
        return;
      }
      // 滑条等控件不拦截
      if (target.closest('input, button, .semi-slider, textarea, a')) {
        return;
      }
      activeTouchId = touch.identifier;
      lastTarget = target;
      event.preventDefault();
      dispatchMouse('mousedown', touch, target);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (activeTouchId === null) {
        return;
      }
      const touch = Array.from(event.touches).find((item) => item.identifier === activeTouchId);
      if (!touch) {
        return;
      }
      event.preventDefault();
      // foundation 在 document 上监听 mousemove
      dispatchMouse('mousemove', touch, document);
    };

    const endTouch = (event: TouchEvent) => {
      if (activeTouchId === null) {
        return;
      }
      const touch =
        Array.from(event.changedTouches).find((item) => item.identifier === activeTouchId) ??
        event.changedTouches[0];
      if (!touch) {
        activeTouchId = null;
        lastTarget = null;
        return;
      }
      event.preventDefault();
      dispatchMouse('mouseup', touch, document);
      activeTouchId = null;
      lastTarget = null;
    };

    root.addEventListener('touchstart', onTouchStart, { passive: false });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', endTouch, { passive: false });
    root.addEventListener('touchcancel', endTouch, { passive: false });
    return () => {
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', endTouch);
      root.removeEventListener('touchcancel', endTouch);
      void lastTarget;
    };
  }, [mobile, ready, visible, src]);

  const applyCrop = () => {
    const canvas = cropperRef.current?.getCropperCanvas?.();
    if (!canvas) {
      return;
    }
    // Semi Cropper 输出 canvas 后重新生成素材；这是破坏式裁剪，但保留原素材可继续在其他元素中使用。
    const width = canvas.width || 1;
    const height = canvas.height || 1;
    onApply(canvas.toDataURL('image/png'), { width, height, aspectRatio: width / height });
  };

  const cropWidth = mobile ? Math.min(620, Math.max(280, window.innerWidth - 48)) : 620;
  const cropHeight = mobile ? Math.min(360, Math.max(220, Math.round(window.innerHeight * 0.42))) : 360;

  return (
    <Modal
      title={title}
      visible={visible && Boolean(src)}
      onCancel={onClose}
      onOk={applyCrop}
      okText="应用裁剪"
      cancelText="取消"
      width={mobile ? Math.min(680, Math.max(320, window.innerWidth - 24)) : 680}
      style={mobile ? { maxWidth: 'calc(100vw - 16px)' } : undefined}
    >
      <div className="grid gap-4" onWheel={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <div
          ref={cropShellRef}
          className="w-full"
          style={{ height: cropHeight, touchAction: mobile ? 'none' : undefined }}
        >
          {ready ? (
            <Cropper
              key={src}
              ref={cropperRef}
              src={src}
              aspectRatio={aspectRatio}
              rotate={rotate}
              zoom={zoom}
              onZoomChange={(nextZoom) => setZoom(Number(nextZoom))}
              fill="rgba(255,255,255,0)"
              shape="rect"
              style={{ width: cropWidth, height: cropHeight }}
            />
          ) : (
            <div className="grid h-full w-full place-items-center rounded-[8px] bg-[#f7f4ed] text-sm text-black/45">正在准备裁剪器</div>
          )}
        </div>
        <CropSlider label="旋转" value={rotate} min={-180} max={180} step={1} onChange={setRotate} suffix="deg" />
        <CropSlider label="缩放" value={zoom} min={0.2} max={3} step={0.05} onChange={setZoom} suffix="x" />
        <Button
          onClick={() => {
            setRotate(0);
            setZoom(1);
          }}
        >
          重置
        </Button>
      </div>
    </Modal>
  );
}

function CropSlider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-black/55">
        <Typography.Text size="small">{label}</Typography.Text>
        <span>
          {Number(value.toFixed(2))}
          {suffix}
        </span>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={(next) => onChange(Number(next))} />
    </div>
  );
}

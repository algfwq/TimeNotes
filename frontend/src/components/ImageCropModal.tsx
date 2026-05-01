import { useEffect, useRef, useState } from 'react';
import { Button, Cropper, Modal, Slider, Typography } from '@douyinfe/semi-ui';

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
  onApply: (dataUrl: string) => void;
}) {
  const cropperRef = useRef<any>(null);
  const [rotate, setRotate] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);

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

  const applyCrop = () => {
    const canvas = cropperRef.current?.getCropperCanvas?.();
    if (!canvas) {
      return;
    }
    // Semi Cropper 输出 canvas 后重新生成素材；这是破坏式裁剪，但保留原素材可继续在其他元素中使用。
    onApply(canvas.toDataURL('image/png'));
  };

  return (
    <Modal title={title} visible={visible && Boolean(src)} onCancel={onClose} onOk={applyCrop} okText="应用裁剪" cancelText="取消" width={680}>
      <div className="grid gap-4">
        <div className="h-[360px] w-full">
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
              style={{ width: 620, height: 360 }}
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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaneImage } from '../dicom/mpr';
import { buildWindowLut } from '../dicom/window';

export interface ImageLayout {
  /** image pixel (continuous, pixel centres at +0.5) -> screen px */
  toScreen: (x: number, y: number) => [number, number];
  sx: number;
  sy: number;
}

interface Props {
  img: PlaneImage;
  title: string;
  color: string;
  win: { center: number; width: number };
  min: number;
  max: number;
  /** extra drawing on top of the image (lines, labels) */
  overlay?: (ctx: CanvasRenderingContext2D, l: ImageLayout, size: { w: number; h: number }) => void;
  onPick?: (x: number, y: number) => void;
  onWheel?: (dir: 1 | -1) => void;
  testId: string;
}

/** A plain 2D view for reformats that are not grid planes (panorama, cross-section). */
export function ImageView({ img, title, color, win, min, max, overlay, onPick, onWheel, testId }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 300, dpr: 1 });

  const lut = useMemo(() => buildWindowLut(min, max, win.center, win.width), [min, max, win.center, win.width]);
  const bitmap = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    const data = ctx.createImageData(img.width, img.height);
    for (let p = 0; p < img.values.length; p++) {
      const g = lut.lut[Math.round(img.values[p]) + lut.offset] ?? 0;
      data.data[p * 4] = data.data[p * 4 + 1] = data.data[p * 4 + 2] = g;
      data.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return c;
  }, [img, lut]);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current!;
    const block = (e: WheelEvent) => e.preventDefault();
    c.addEventListener('wheel', block, { passive: false });
    return () => c.removeEventListener('wheel', block);
  }, []);

  const layout = useMemo(() => {
    const pw = img.width * img.pixelMm[0];
    const ph = img.height * img.pixelMm[1];
    const top = 26;
    const mmToPx = Math.min(size.w / pw, (size.h - top - 20) / ph) * 0.96;
    const sx = mmToPx * img.pixelMm[0];
    const sy = mmToPx * img.pixelMm[1];
    const ox = (size.w - img.width * sx) / 2;
    const oy = top + (size.h - top - 20 - img.height * sy) / 2;
    return { sx, sy, ox, oy, toScreen: (x: number, y: number): [number, number] => [ox + x * sx, oy + y * sy] };
  }, [img, size]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = Math.round(size.w * size.dpr);
    canvas.height = Math.round(size.h * size.dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bitmap, layout.ox, layout.oy, img.width * layout.sx, img.height * layout.sy);
    overlay?.(ctx, layout, size);
    ctx.fillStyle = color;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(title, 8, 18);
    // 10 mm scale bar
    const bar = 10 * (layout.sx / img.pixelMm[0]);
    ctx.fillStyle = '#ddd';
    ctx.fillRect(size.w - 16 - bar, size.h - 14, bar, 3);
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('10 mm', size.w - 16, size.h - 18);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`${img.width}×${img.height}  ${img.pixelMm[0].toFixed(3)}×${img.pixelMm[1].toFixed(3)} mm  W ${Math.round(win.width)} L ${Math.round(win.center)}`, 8, size.h - 8);
  });

  return (
    <div ref={wrapRef} className="view" data-view={testId}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: onPick ? 'pointer' : 'default' }}
        onPointerDown={(e) => {
          if (!onPick || e.button !== 0) return;
          const r = canvasRef.current!.getBoundingClientRect();
          const x = (e.clientX - r.left - layout.ox) / layout.sx;
          const y = (e.clientY - r.top - layout.oy) / layout.sy;
          if (x >= 0 && y >= 0 && x < img.width && y < img.height) onPick(x, y);
        }}
        onWheel={(e) => onWheel?.(e.deltaY > 0 ? 1 : -1)}
      />
    </div>
  );
}

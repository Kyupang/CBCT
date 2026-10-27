import { useEffect, useMemo, useRef, useState } from 'react';
import { axisVector, directionLabel, extractPlane, planeDef, planeToVoxel, voxelToPlane, type ViewKind } from '../dicom/mpr';
import { voxelToPatient, type Volume } from '../dicom/volume';
import { buildWindowLut } from '../dicom/window';
import { dist, scale, type Vec3 } from '../dicom/vec';

export type Tool = 'crosshair' | 'measure';

export interface Measurement {
  id: number;
  view: ViewKind;
  a: Vec3; // voxel coords
  b: Vec3;
}

interface Props {
  vol: Volume;
  kind: ViewKind;
  cursor: Vec3;
  onCursor: (v: Vec3) => void;
  onHover: (v: Vec3 | undefined) => void;
  win: { center: number; width: number };
  onWindow: (w: { center: number; width: number }) => void;
  tool: Tool;
  measurements: Measurement[];
  onMeasure: (m: Omit<Measurement, 'id'>) => void;
  smooth: boolean;
}

const TITLES: Record<ViewKind, string> = { axial: 'Axial', coronal: 'Coronal', sagittal: 'Sagittal' };
const COLORS: Record<ViewKind, string> = { axial: '#4fc3f7', coronal: '#81c784', sagittal: '#ffb74d' };

export function measurementMm(vol: Volume, m: { a: Vec3; b: Vec3 }): number {
  return dist(voxelToPatient(vol, ...m.a), voxelToPatient(vol, ...m.b));
}

export function MprView({ vol, kind, cursor, onCursor, onHover, win, onWindow, tool, measurements, onMeasure, smooth }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 300, dpr: 1 });
  const [zoom, setZoom] = useState(1);
  const [pending, setPending] = useState<Vec3 | undefined>();
  const [hoverPt, setHoverPt] = useState<Vec3 | undefined>();
  const def = useMemo(() => planeDef(vol, kind), [vol, kind]);
  const slice = Math.round(cursor[def.w]);

  // Plane bitmap at native voxel resolution; physical aspect is applied when drawing.
  const plane = useMemo(() => extractPlane(vol, def, cursor), [vol, def, slice]); // eslint-disable-line react-hooks/exhaustive-deps
  const lut = useMemo(() => buildWindowLut(vol.min, vol.max, win.center, win.width), [vol, win.center, win.width]);
  const bitmap = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = plane.width;
    c.height = plane.height;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(plane.width, plane.height);
    const { values } = plane;
    for (let p = 0; p < values.length; p++) {
      const g = lut.lut[Math.round(values[p]) + lut.offset] ?? 0;
      img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = g;
      img.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }, [plane, lut]);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // React's wheel listener is passive; block page scroll / browser zoom natively.
  useEffect(() => {
    const c = canvasRef.current!;
    const block = (e: WheelEvent) => e.preventDefault();
    c.addEventListener('wheel', block, { passive: false });
    return () => c.removeEventListener('wheel', block);
  }, []);

  // screen layout: one plane pixel = pixelMm[0] x pixelMm[1] mm, uniformly scaled to fit.
  const layout = useMemo(() => {
    const pw = plane.width * plane.pixelMm[0];
    const ph = plane.height * plane.pixelMm[1];
    const mmToPx = Math.min(size.w / pw, size.h / ph) * 0.94 * zoom;
    const sx = mmToPx * plane.pixelMm[0];
    const sy = mmToPx * plane.pixelMm[1];
    return { sx, sy, ox: (size.w - plane.width * sx) / 2, oy: (size.h - plane.height * sy) / 2 };
  }, [plane, size, zoom]);

  const toScreen = (v: Vec3): [number, number] => {
    const [x, y] = voxelToPlane(vol, def, v);
    return [layout.ox + (x + 0.5) * layout.sx, layout.oy + (y + 0.5) * layout.sy];
  };
  const fromScreen = (px: number, py: number): Vec3 => {
    const x = (px - layout.ox) / layout.sx - 0.5;
    const y = (py - layout.oy) / layout.sy - 0.5;
    const v = planeToVoxel(vol, def, x, y, cursor);
    v[def.w] = slice;
    return v;
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = Math.round(size.w * size.dpr);
    canvas.height = Math.round(size.h * size.dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.imageSmoothingEnabled = smooth;
    ctx.drawImage(bitmap, layout.ox, layout.oy, plane.width * layout.sx, plane.height * layout.sy);

    // crosshair: the other two planes through the shared cursor
    const [cx, cy] = toScreen(cursor);
    const others = (['axial', 'coronal', 'sagittal'] as ViewKind[]).filter((k) => k !== kind);
    for (const o of others) {
      const od = planeDef(vol, o);
      ctx.strokeStyle = COLORS[o];
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (od.w === def.u) {
        ctx.moveTo(cx, layout.oy);
        ctx.lineTo(cx, layout.oy + plane.height * layout.sy);
      } else {
        ctx.moveTo(layout.ox, cy);
        ctx.lineTo(layout.ox + plane.width * layout.sx, cy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // measurements that lie in this plane
    const drawSeg = (a: Vec3, b: Vec3, label: string) => {
      const [ax, ay] = toScreen(a);
      const [bx, by] = toScreen(b);
      ctx.strokeStyle = '#ffeb3b';
      ctx.fillStyle = '#ffeb3b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      for (const [x, y] of [
        [ax, ay],
        [bx, by],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(label, (ax + bx) / 2 + 6, (ay + by) / 2 - 6);
    };
    for (const m of measurements) {
      if (m.view !== kind || Math.round(m.a[def.w]) !== slice) continue;
      drawSeg(m.a, m.b, `${measurementMm(vol, m).toFixed(2)} mm`);
    }
    if (pending && hoverPt && tool === 'measure') drawSeg(pending, hoverPt, `${measurementMm(vol, { a: pending, b: hoverPt }).toFixed(2)} mm`);

    // orientation letters from the actual direction cosines
    const uVec = axisVector(vol, def.u);
    const vVec = axisVector(vol, def.v);
    const right = def.flipU ? scale(uVec, -1) : uVec;
    const down = def.flipV ? scale(vVec, -1) : vVec;
    ctx.fillStyle = '#ddd';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(directionLabel(right), size.w - 12, size.h / 2);
    ctx.fillText(directionLabel(scale(right, -1)), 12, size.h / 2);
    ctx.fillText(directionLabel(down), size.w / 2, size.h - 12);
    ctx.fillText(directionLabel(scale(down, -1)), size.w / 2, 14);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS[kind];
    ctx.fillText(TITLES[kind], 8, 18);
    ctx.fillStyle = '#aaa';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`${slice + 1}/${vol.dims[def.w]}  ${plane.pixelMm[0].toFixed(3)}×${plane.pixelMm[1].toFixed(3)} mm`, 8, size.h - 22);
    ctx.fillText(`W ${Math.round(win.width)} L ${Math.round(win.center)}`, 8, size.h - 8);
  });

  const drag = useRef<{ mode: 'cursor' | 'wl'; x: number; y: number; win: { center: number; width: number } } | undefined>(undefined);
  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const clampVox = (v: Vec3): Vec3 => v.map((x, a) => Math.min(vol.dims[a] - 1, Math.max(0, x))) as Vec3;
  const inside = (v: Vec3) => v.every((x, a) => x >= -0.5 && x <= vol.dims[a] - 0.5);

  return (
    <div ref={wrapRef} className="view" data-view={kind} onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: tool === 'measure' ? 'crosshair' : 'default' }}
        onPointerDown={(e) => {
          const [x, y] = local(e);
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
            drag.current = { mode: 'wl', x, y, win };
            return;
          }
          if (e.button !== 0) return;
          const v = fromScreen(x, y);
          if (tool === 'measure') {
            if (!inside(v)) return;
            if (!pending) setPending(v);
            else {
              onMeasure({ view: kind, a: pending, b: v });
              setPending(undefined);
            }
            return;
          }
          drag.current = { mode: 'cursor', x, y, win };
          onCursor(clampVox(v));
        }}
        onPointerMove={(e) => {
          const [x, y] = local(e);
          const v = fromScreen(x, y);
          setHoverPt(v);
          onHover(inside(v) ? v : undefined);
          const d = drag.current;
          if (!d) return;
          if (d.mode === 'wl') {
            const k = Math.max(1, (vol.max - vol.min) / 600);
            onWindow({ center: d.win.center + (y - d.y) * k, width: Math.max(1, d.win.width + (x - d.x) * k) });
          } else onCursor(clampVox(v));
        }}
        onPointerUp={() => (drag.current = undefined)}
        onPointerLeave={() => onHover(undefined)}
        onWheel={(e) => {
          if (e.ctrlKey) {
            setZoom((z) => Math.min(8, Math.max(0.5, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
            return;
          }
          const next: Vec3 = [...cursor];
          next[def.w] = Math.min(vol.dims[def.w] - 1, Math.max(0, slice + (e.deltaY > 0 ? 1 : -1)));
          onCursor(next);
        }}
        onDoubleClick={() => setZoom(1)}
      />
    </div>
  );
}

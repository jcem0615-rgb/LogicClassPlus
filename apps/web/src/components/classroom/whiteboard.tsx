'use client';

/**
 * Vector whiteboard. Strokes are kept as points rather than pixels, so undo
 * and a resize both stay sharp, and one finished stroke is what goes over the
 * wire to the other participant.
 *
 * Those points are in *board* coordinates — a fixed page, not the pixels of
 * whichever window drew them. That is what lets the board zoom, and it is also
 * the only way two participants on different screen sizes see a stroke land in
 * the same place.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';

export interface Stroke {
  tool: 'pen' | 'marker' | 'line' | 'rect' | 'eraser' | 'text';
  color: string;
  width: number;
  alpha: number;
  points: Array<{ x: number; y: number }>;
  text?: string;
}

/** The page everyone draws on, in board units. 16:10, like the canvas area. */
export const BOARD = { w: 1600, h: 1000 };

export interface BoardView {
  /** 1 means the whole page fits the canvas. */
  zoom: number;
  /** Top-left of the visible area, in board units. */
  panX: number;
  panY: number;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

/** Canvas pixels per board unit when the page is shown whole. */
export const fitScale = (w: number, h: number): number =>
  Math.min(w / BOARD.w, h / BOARD.h);

const PALETTE = ['#13222B', '#A02B2B', '#2E5AAC', '#1C7A4B', '#845F00', '#7A3BAF'];
const TOOLS: Array<[Stroke['tool'], string]> = [
  ['pen', 'Pen'], ['marker', 'Highlighter'], ['line', 'Line'], ['rect', 'Box'], ['eraser', 'Eraser'],
];

export function drawStrokes(
  ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number,
  background?: HTMLImageElement | null,
  /** Omitted by the annotator, whose strokes are in its own canvas pixels. */
  view?: BoardView,
): void {
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  // When zoomed out the page does not fill the canvas, so the surround needs a
  // colour of its own — otherwise the edge of the board is invisible.
  ctx.fillStyle = view ? '#E8ECEE' : '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  let pageW = w;
  let pageH = h;
  if (view) {
    const scale = fitScale(w, h) * view.zoom;
    ctx.translate(-view.panX * scale, -view.panY * scale);
    ctx.scale(scale, scale);
    pageW = BOARD.w;
    pageH = BOARD.h;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, pageW, pageH);
  }

  if (background) {
    const scale = Math.min(pageW / background.width, pageH / background.height);
    const bw = background.width * scale;
    const bh = background.height * scale;
    ctx.drawImage(background, (pageW - bw) / 2, (pageH - bh) / 2, bw, bh);
  } else {
    // A faint grid, so an empty board still reads as a board.
    ctx.strokeStyle = 'rgba(19,34,43,.07)';
    ctx.lineWidth = 1;
    for (let x = 32; x < pageW; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, pageH); ctx.stroke(); }
    for (let y = 32; y < pageH; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pageW, y); ctx.stroke(); }
  }

  for (const stroke of strokes) {
    const points = stroke.points;
    if (!points.length) continue;
    ctx.globalAlpha = stroke.alpha;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const [first, second] = points;
    if (stroke.tool === 'rect' && first && second) {
      ctx.strokeRect(first.x, first.y, second.x - first.x, second.y - first.y);
    } else if (stroke.tool === 'line' && first && second) {
      ctx.beginPath(); ctx.moveTo(first.x, first.y); ctx.lineTo(second.x, second.y); ctx.stroke();
    } else if (stroke.tool === 'text' && first) {
      ctx.font = `600 ${stroke.width * 6}px var(--font-ui)`;
      ctx.fillText(stroke.text ?? '', first.x, first.y);
    } else if (first) {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      if (points.length === 1) ctx.lineTo(first.x + 0.1, first.y + 0.1);
      ctx.stroke();
    }
  }

  if (view) {
    // The page edge, so it is obvious where the board stops.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(19,34,43,.22)';
    ctx.lineWidth = 2 / (fitScale(w, h) * view.zoom);
    ctx.strokeRect(0, 0, BOARD.w, BOARD.h);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

export function Whiteboard({ strokes, onStroke, onClear, onSave, live }: {
  strokes: Stroke[];
  onStroke: (stroke: Stroke) => void;
  onClear: () => void;
  onSave?: (canvas: HTMLCanvasElement) => void;
  live: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const panFrom = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [tool, setTool] = useState<Stroke['tool']>('pen');
  const [color, setColor] = useState(PALETTE[0]!);
  const [width, setWidth] = useState(3);
  const [size, setSize] = useState({ w: 640, h: 400 });
  const [view, setView] = useState<BoardView>({ zoom: 1, panX: 0, panY: 0 });
  const [panning, setPanning] = useState(false);

  const repaint = useCallback((extra?: Stroke | null) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    drawStrokes(ctx, extra ? [...strokes, extra] : strokes, size.w, size.h, null, view);
  }, [strokes, size, view]);

  useEffect(() => {
    const element = wrap.current;
    const node = canvas.current;
    if (!element || !node) return undefined;

    const resize = () => {
      const w = element.clientWidth || 640;
      const h = Math.round(w * (BOARD.h / BOARD.w));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      node.width = w * dpr;
      node.height = h * dpr;
      node.style.height = `${h}px`;
      node.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      setSize({ w, h });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { repaint(); }, [repaint]);

  /** Screen pixels inside the canvas → board units. */
  const position = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = fitScale(size.w, size.h) * view.zoom;
    return {
      x: (e.clientX - rect.left) / scale + view.panX,
      y: (e.clientY - rect.top) / scale + view.panY,
    };
  };

  /** Keeps the page from being dragged entirely out of sight. */
  const clampPan = useCallback((next: BoardView): BoardView => {
    const scale = fitScale(size.w, size.h) * next.zoom;
    const visibleW = size.w / scale;
    const visibleH = size.h / scale;
    const maxX = Math.max(0, BOARD.w - visibleW);
    const maxY = Math.max(0, BOARD.h - visibleH);
    return {
      zoom: next.zoom,
      panX: Math.min(Math.max(0, next.panX), maxX),
      panY: Math.min(Math.max(0, next.panY), maxY),
    };
  }, [size]);

  /** Zooms about a point in board units, so what you aim at stays put. */
  const zoomTo = useCallback((zoom: number, at?: { x: number; y: number }) => {
    setView((v) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
      const scaleNow = fitScale(size.w, size.h) * v.zoom;
      const anchor = at ?? { x: v.panX + size.w / scaleNow / 2, y: v.panY + size.h / scaleNow / 2 };
      const scaleNext = fitScale(size.w, size.h) * next;
      return clampPan({
        zoom: next,
        panX: anchor.x - (anchor.x - v.panX) * (scaleNow / scaleNext),
        panY: anchor.y - (anchor.y - v.panY) * (scaleNow / scaleNext),
      });
    });
  }, [size, clampPan]);

  const percent = Math.round(view.zoom * 100);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-line bg-card-2 p-2">
        {TOOLS.map(([id, label]) => (
          <Button key={id} size="sm" variant={tool === id && !panning ? 'primary' : 'default'}
            onClick={() => { setTool(id); setPanning(false); }}>{label}</Button>
        ))}
        <span className="mx-1 h-5 w-px bg-line-2" />
        {PALETTE.map((c) => (
          <button key={c} aria-label={`colour ${c}`} onClick={() => setColor(c)}
            className={`h-5 w-5 rounded-full border-2 ${color === c ? 'border-ink' : 'border-transparent'}`}
            style={{ background: c }} />
        ))}
        <span className="mx-1 h-5 w-px bg-line-2" />
        <input type="range" min={1} max={18} value={width} aria-label="Stroke width"
          className="w-[90px]" onChange={(e) => setWidth(Number(e.target.value))} />
        <span className="mx-1 h-5 w-px bg-line-2" />

        <Button size="sm" aria-label="Zoom out" data-testid="zoom-out"
          onClick={() => zoomTo(view.zoom - 0.25)}>−</Button>
        <span data-testid="zoom-level" className="min-w-[48px] text-center font-mono text-[12.5px] text-ink-2">
          {percent}%
        </span>
        <Button size="sm" aria-label="Zoom in" data-testid="zoom-in"
          onClick={() => zoomTo(view.zoom + 0.25)}>+</Button>
        <Button size="sm" data-testid="zoom-fit"
          onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })}>Fit</Button>
        <Button size="sm" variant={panning ? 'primary' : 'default'} data-testid="zoom-pan"
          onClick={() => setPanning((v) => !v)}>Pan</Button>

        <span className="mx-1 h-5 w-px bg-line-2" />
        <Button size="sm" onClick={onClear}>Clear</Button>
        {onSave ? (
          <Button size="sm" variant="primary"
            onClick={() => canvas.current && onSave(canvas.current)}>Save to library</Button>
        ) : null}
      </div>

      <div ref={wrap} className="relative overflow-hidden rounded-sm border border-line bg-white"
        style={{ touchAction: 'none' }}>
        <canvas
          ref={canvas}
          className="block w-full"
          style={{ touchAction: 'none', cursor: panning ? 'grab' : 'crosshair' }}
          onWheel={(e) => {
            // Ctrl/⌘ + wheel is the zoom gesture every drawing tool uses, and
            // it leaves a plain wheel free to scroll the page as usual.
            if (!e.ctrlKey && !e.metaKey) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const scale = fitScale(size.w, size.h) * view.zoom;
            zoomTo(view.zoom * (e.deltaY < 0 ? 1.1 : 0.9), {
              x: (e.clientX - rect.left) / scale + view.panX,
              y: (e.clientY - rect.top) / scale + view.panY,
            });
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            // Middle button pans whatever tool is selected — the usual shortcut.
            if (panning || e.button === 1) {
              panFrom.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
              return;
            }
            drawing.current = {
              tool,
              color: tool === 'eraser' ? '#FFFFFF' : color,
              width: tool === 'marker' ? width * 4 : tool === 'eraser' ? width * 5 : width,
              alpha: tool === 'marker' ? 0.28 : 1,
              points: [position(e)],
            };
          }}
          onPointerMove={(e) => {
            const from = panFrom.current;
            if (from) {
              const scale = fitScale(size.w, size.h) * view.zoom;
              setView((v) => clampPan({
                zoom: v.zoom,
                panX: from.panX - (e.clientX - from.x) / scale,
                panY: from.panY - (e.clientY - from.y) / scale,
              }));
              return;
            }
            const stroke = drawing.current;
            if (!stroke) return;
            const point = position(e);
            if (stroke.tool === 'line' || stroke.tool === 'rect') stroke.points[1] = point;
            else stroke.points.push(point);
            repaint(stroke);
          }}
          onPointerUp={() => {
            panFrom.current = null;
            const stroke = drawing.current;
            drawing.current = null;
            if (stroke && stroke.points.length) onStroke(stroke);
          }}
        />
      </div>

      <p className="text-[13px] text-ink-3">
        Strokes are kept as vectors on a fixed page, so zooming, resizing and the
        other participant&apos;s screen size all stay in step.{' '}
        {live
          ? <>Each finished stroke is broadcast on <span className="font-mono">classroom:board:stroke</span> and lands on every board in the room.</>
          : 'Connect to a session to broadcast each stroke to the other participant.'}
      </p>
    </div>
  );
}

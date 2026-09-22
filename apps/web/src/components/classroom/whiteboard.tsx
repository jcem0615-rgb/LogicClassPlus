'use client';

/**
 * Vector whiteboard. Strokes are kept as points rather than pixels, so undo
 * and a resize both stay sharp, and one finished stroke is what goes over the
 * wire to the other participant.
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

const PALETTE = ['#13222B', '#A02B2B', '#2E5AAC', '#1C7A4B', '#845F00', '#7A3BAF'];
const TOOLS: Array<[Stroke['tool'], string]> = [
  ['pen', 'Pen'], ['marker', 'Highlighter'], ['line', 'Line'], ['rect', 'Box'], ['eraser', 'Eraser'],
];

export function drawStrokes(
  ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number, background?: HTMLImageElement | null,
): void {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  if (background) {
    const scale = Math.min(w / background.width, h / background.height);
    const bw = background.width * scale;
    const bh = background.height * scale;
    ctx.drawImage(background, (w - bw) / 2, (h - bh) / 2, bw, bh);
  } else {
    // A faint grid, so an empty board still reads as a board.
    ctx.strokeStyle = 'rgba(19,34,43,.07)';
    ctx.lineWidth = 1;
    for (let x = 32; x < w; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 32; y < h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
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
  const [tool, setTool] = useState<Stroke['tool']>('pen');
  const [color, setColor] = useState(PALETTE[0]!);
  const [width, setWidth] = useState(3);
  const [size, setSize] = useState({ w: 640, h: 400 });

  const repaint = useCallback((extra?: Stroke | null) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    drawStrokes(ctx, extra ? [...strokes, extra] : strokes, size.w, size.h);
  }, [strokes, size]);

  useEffect(() => {
    const element = wrap.current;
    const node = canvas.current;
    if (!element || !node) return undefined;

    const resize = () => {
      const w = element.clientWidth || 640;
      const h = Math.round(w * 0.62);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      node.width = w * dpr;
      node.height = h * dpr;
      node.style.height = `${h}px`;
      node.getContext('2d')?.scale(dpr, dpr);
      setSize({ w, h });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { repaint(); }, [repaint]);

  const position = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-line bg-card-2 p-2">
        {TOOLS.map(([id, label]) => (
          <Button key={id} size="sm" variant={tool === id ? 'primary' : 'default'}
            onClick={() => setTool(id)}>{label}</Button>
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
          style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = {
              tool,
              color: tool === 'eraser' ? '#FFFFFF' : color,
              width: tool === 'marker' ? width * 4 : tool === 'eraser' ? width * 5 : width,
              alpha: tool === 'marker' ? 0.28 : 1,
              points: [position(e)],
            };
          }}
          onPointerMove={(e) => {
            const stroke = drawing.current;
            if (!stroke) return;
            const point = position(e);
            if (stroke.tool === 'line' || stroke.tool === 'rect') stroke.points[1] = point;
            else stroke.points.push(point);
            repaint(stroke);
          }}
          onPointerUp={() => {
            const stroke = drawing.current;
            drawing.current = null;
            if (stroke && stroke.points.length) onStroke(stroke);
          }}
        />
      </div>

      <p className="text-[13px] text-ink-3">
        Strokes are kept as vectors, so undo and resize stay sharp.{' '}
        {live
          ? <>Each finished stroke is broadcast on <span className="font-mono">classroom:board:stroke</span> and lands on your student&apos;s board.</>
          : 'Connect to a session to broadcast each stroke to the other participant.'}
      </p>
    </div>
  );
}

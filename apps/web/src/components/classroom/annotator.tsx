'use client';

/** Annotate a PDF page or an image: the same ink layer over a background. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Flag } from '@/components/ui';
import { drawStrokes, type Stroke } from './whiteboard';

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const PALETTE = ['#A02B2B', '#13222B', '#2E5AAC', '#1C7A4B'];

export function Annotator({ onSave }: { onSave?: (canvas: HTMLCanvasElement) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const background = useRef<HTMLImageElement | null>(null);
  const drawing = useRef<Stroke | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<'pen' | 'marker'>('pen');
  const [color, setColor] = useState(PALETTE[0]!);
  const [size, setSize] = useState({ w: 640, h: 400 });
  const [message, setMessage] = useState<string | null>(null);

  const repaint = useCallback((extra?: Stroke | null) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    drawStrokes(ctx, extra ? [...strokes, extra] : strokes, size.w, size.h, background.current);
  }, [strokes, size]);

  useEffect(() => {
    const element = wrap.current;
    const node = canvas.current;
    if (!element || !node) return undefined;
    const resize = () => {
      const w = element.clientWidth || 640;
      const h = Math.round(w * 0.62);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      node.width = w * dpr; node.height = h * dpr; node.style.height = `${h}px`;
      node.getContext('2d')?.scale(dpr, dpr);
      setSize({ w, h });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { repaint(); }, [repaint]);

  async function open(file: File) {
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED.includes(ext)) { setMessage(`.${ext} cannot be annotated. Open a PDF or an image.`); return; }
    if (file.size > MAX_BYTES) { setMessage('That file is over the 20 MB limit.'); return; }
    setMessage(null);

    if (ext === 'pdf') {
      try {
        const pdfjs = await import('pdfjs-dist');
        // The worker ships with the package; bundling it keeps this off a CDN.
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(
          new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
        const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        const off = document.createElement('canvas');
        off.width = viewport.width; off.height = viewport.height;
        const ctx = off.getContext('2d');
        if (!ctx) throw new Error('Could not draw the page.');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const img = new Image();
        img.onload = () => { background.current = img; setStrokes([]); repaint(); };
        img.src = off.toDataURL('image/jpeg', 0.85);
      } catch (err) {
        setMessage(`Could not open that PDF: ${(err as Error).message}`);
      }
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { background.current = img; setStrokes([]); repaint(); URL.revokeObjectURL(url); };
    img.onerror = () => setMessage('Could not read that image.');
    img.src = url;
  }

  const position = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-line bg-card-2 p-2">
        <label htmlFor="ann-file" className="cursor-pointer">
          <span className="inline-flex items-center rounded-sm border border-line-2 bg-card px-2.5 py-1 text-[13px] font-medium">
            Open PDF or image
          </span>
        </label>
        <input id="ann-file" type="file" accept=".pdf,image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(f); }} />
        <span className="mx-1 h-5 w-px bg-line-2" />
        {PALETTE.map((c) => (
          <button key={c} aria-label={`colour ${c}`} onClick={() => setColor(c)}
            className={`h-5 w-5 rounded-full border-2 ${color === c ? 'border-ink' : 'border-transparent'}`}
            style={{ background: c }} />
        ))}
        <span className="mx-1 h-5 w-px bg-line-2" />
        <Button size="sm" variant={tool === 'pen' ? 'primary' : 'default'} onClick={() => setTool('pen')}>Pen</Button>
        <Button size="sm" variant={tool === 'marker' ? 'primary' : 'default'} onClick={() => setTool('marker')}>Highlighter</Button>
        <Button size="sm" onClick={() => setStrokes((s) => s.slice(0, -1))}>Undo</Button>
        <Button size="sm" onClick={() => setStrokes([])}>Clear ink</Button>
        {onSave ? (
          <Button size="sm" variant="primary" onClick={() => canvas.current && onSave(canvas.current)}>
            Save to library
          </Button>
        ) : null}
      </div>

      <div ref={wrap} className="overflow-hidden rounded-sm border border-line bg-white" style={{ touchAction: 'none' }}>
        <canvas
          ref={canvas} className="block w-full" style={{ touchAction: 'none' }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = {
              tool, color, width: tool === 'marker' ? 12 : 3,
              alpha: tool === 'marker' ? 0.28 : 1, points: [position(e)],
            };
          }}
          onPointerMove={(e) => {
            const stroke = drawing.current;
            if (!stroke) return;
            stroke.points.push(position(e));
            repaint(stroke);
          }}
          onPointerUp={() => {
            const stroke = drawing.current;
            drawing.current = null;
            if (stroke?.points.length) setStrokes((s) => [...s, stroke]);
          }}
        />
      </div>

      {message ? <Flag title="Not opened">{message}</Flag> : null}
      <p className="text-[13px] text-ink-3">
        Uploads are checked against the same rules as the library: 20 MB per file, allowed
        extensions only.
      </p>
    </div>
  );
}

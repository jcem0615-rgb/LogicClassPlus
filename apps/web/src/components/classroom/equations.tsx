'use client';

/**
 * LaTeX for the Math suite.
 *
 * KaTeX renders to MathML rather than its HTML output: MathML is laid out by
 * the browser, so no KaTeX stylesheet and no font files are needed.
 */
import { useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import { Button } from '@/components/ui';

const SNIPPETS = ['\\frac{a}{b}', 'x^{2}', '\\sqrt{x}', '\\int_{0}^{1}', '\\sum_{i=1}^{n}',
  '\\lim_{x \\to 0}', '\\theta', '\\pi', '\\Delta', '\\approx'];

export function Equations({ initial, onSave, onSendToBoard }: {
  initial: string;
  onSave: (tex: string) => void;
  onSendToBoard: (tex: string) => void;
}) {
  const [tex, setTex] = useState(initial || '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}');

  useEffect(() => { if (initial) setTex(initial); }, [initial]);

  const rendered = useMemo(() => {
    try {
      return { html: katex.renderToString(tex, { output: 'mathml', displayMode: true, throwOnError: true }), error: null };
    } catch (err) {
      return { html: null, error: (err as Error).message };
    }
  }, [tex]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow">LaTeX equation editor</span>
        <span className="text-[13px] text-ink-3">rendered with KaTeX → MathML</span>
      </div>

      <div className="grid min-h-[76px] place-items-center overflow-x-auto rounded-sm border border-line bg-card-2 p-4 text-[22px]">
        {rendered.html
          ? <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
          : <span className="text-[13px] text-crit">{rendered.error}</span>}
      </div>

      <textarea
        id="eq-src" value={tex} spellCheck={false} rows={3}
        className="min-h-[90px] font-mono"
        onChange={(e) => setTex(e.target.value)}
      />

      <div className="flex flex-wrap gap-1.5 rounded-sm border border-line bg-card-2 p-2">
        {SNIPPETS.map((s) => (
          <Button key={s} size="sm" className="font-mono" onClick={() => setTex((t) => t + s)}>{s}</Button>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => onSendToBoard(tex)}>Send to whiteboard</Button>
        <Button size="sm" variant="primary" onClick={() => onSave(tex)}>Save to session notes</Button>
      </div>
    </div>
  );
}

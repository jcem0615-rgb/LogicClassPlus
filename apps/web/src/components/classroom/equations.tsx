'use client';

/**
 * Maths notation for the Math suite.
 *
 * A tutor mid-class should not have to remember LaTeX. The default view is a
 * big preview and buttons named after what they insert; the source is there
 * for anyone who wants it, one click away and out of the way otherwise.
 *
 * KaTeX renders to MathML rather than its HTML output: MathML is laid out by
 * the browser, so no KaTeX stylesheet and no font files are needed.
 */
import { useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import { Button } from '@/components/ui';

/** Whole equations worth starting from, named the way a teacher would ask. */
const STARTERS: Array<[string, string]> = [
  ['Quadratic formula', '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'],
  ['Pythagoras', 'a^{2} + b^{2} = c^{2}'],
  ['Area of a circle', 'A = \\pi r^{2}'],
  ['Slope', 'm = \\frac{y_2 - y_1}{x_2 - x_1}'],
];

/** Pieces to drop in, labelled by what they are rather than how they spell. */
const PIECES: Array<[string, string]> = [
  ['Fraction', '\\frac{a}{b}'],
  ['Power', 'x^{2}'],
  ['Square root', '\\sqrt{x}'],
  ['Subscript', 'x_{1}'],
  ['Sum', '\\sum_{i=1}^{n}'],
  ['Integral', '\\int_{0}^{1}'],
  ['Limit', '\\lim_{x \\to 0}'],
  ['×', '\\times'],
  ['÷', '\\div'],
  ['±', '\\pm'],
  ['≠', '\\neq'],
  ['≤', '\\leq'],
  ['≥', '\\geq'],
  ['π', '\\pi'],
  ['θ', '\\theta'],
  ['°', '^{\\circ}'],
];

export function Equations({ initial, onSave, onSendToBoard }: {
  initial: string;
  onSave: (tex: string) => void;
  onSendToBoard: (tex: string) => void;
}) {
  const [tex, setTex] = useState(initial || STARTERS[0]![1]);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => { if (initial) setTex(initial); }, [initial]);

  const rendered = useMemo(() => {
    try {
      return {
        html: katex.renderToString(tex, { output: 'mathml', displayMode: true, throwOnError: true }),
        error: null,
      };
    } catch (err) {
      return { html: null, error: (err as Error).message };
    }
  }, [tex]);

  const add = (piece: string) => setTex((t) => (t ? `${t} ${piece}` : piece));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid min-h-[96px] place-items-center overflow-x-auto rounded-sm border border-line bg-card-2 p-4 text-[26px]">
        {rendered.html
          ? <span data-testid="eq-preview" dangerouslySetInnerHTML={{ __html: rendered.html }} />
          : (
            <span className="text-[13px] text-crit">
              That is not valid notation yet — undo the last piece, or open the source to fix it.
            </span>
          )}
      </div>

      <div>
        <div className="eyebrow mb-1.5">Start from</div>
        <div className="flex flex-wrap gap-1.5">
          {STARTERS.map(([label, value]) => (
            <Button key={label} size="sm" onClick={() => setTex(value)}>{label}</Button>
          ))}
        </div>
      </div>

      <div>
        <div className="eyebrow mb-1.5">Add a piece</div>
        <div className="flex flex-wrap gap-1.5">
          {PIECES.map(([label, value]) => (
            <Button key={label} size="sm" onClick={() => add(value)}>{label}</Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => setTex('')}>Clear</Button>
          <Button size="sm" data-testid="eq-source-toggle" onClick={() => setShowSource((v) => !v)}>
            {showSource ? 'Hide LaTeX' : 'Edit LaTeX'}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onSendToBoard(tex)}>Send to whiteboard</Button>
          <Button size="sm" variant="primary" onClick={() => onSave(tex)}>Save to notes</Button>
        </div>
      </div>

      {showSource ? (
        <textarea
          id="eq-src" value={tex} spellCheck={false} rows={3}
          className="min-h-[90px] font-mono"
          aria-label="LaTeX source"
          onChange={(e) => setTex(e.target.value)}
        />
      ) : null}
    </div>
  );
}

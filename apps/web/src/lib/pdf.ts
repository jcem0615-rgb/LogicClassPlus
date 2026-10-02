/**
 * Wrapping a picture in a PDF.
 *
 * Saving a whiteboard to the library used to produce a JPEG, which is fine
 * for looking at and wrong for everything else: it does not print to a known
 * paper size, it cannot be annotated by the usual tools, and a parent asked
 * to open "the worksheet" gets an image. A PDF opens in every reader on
 * every device, which is the point of asking for one.
 *
 * This writes the file by hand rather than pulling in a PDF library. A
 * single-page document containing one JPEG is a small, completely specified
 * thing: JPEG is a native PDF image filter (DCTDecode), so the encoded bytes
 * go in untouched and no pixels are re-encoded. A library would be three
 * hundred kilobytes of other people's edge cases to do the same job.
 */

/** A4 at 72dpi, the unit PDF measures in. */
const A4 = { width: 595.28, height: 841.89 };

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** PDF strings escape these three, and nothing in a title should break it. */
const pdfText = (value: string): string =>
  value.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '');

/**
 * One JPEG, centred on a page, fitted to the paper with a margin and never
 * enlarged past its own size.
 */
export function jpegToPdf(jpeg: Uint8Array, options: {
  width: number; height: number; title?: string; caption?: string;
}): Blob {
  const margin = 36;
  const room = {
    width: A4.width - margin * 2,
    height: A4.height - margin * 2 - (options.caption ? 24 : 0),
  };
  const scale = Math.min(room.width / options.width, room.height / options.height, 1);
  const drawn = { width: options.width * scale, height: options.height * scale };
  const x = (A4.width - drawn.width) / 2;
  const y = (A4.height - drawn.height) / 2 + (options.caption ? 12 : 0);

  const content = [
    'q',
    `${drawn.width.toFixed(2)} 0 0 ${drawn.height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm`,
    '/Im0 Do',
    'Q',
    ...(options.caption ? [
      'BT', '/F1 10 Tf', '0.35 0.4 0.4 rg',
      `${margin} ${(y - 18).toFixed(2)} Td`,
      `(${pdfText(options.caption)}) Tj`,
      'ET',
    ] : []),
  ].join('\n');

  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array[]) => {
    objects.push(typeof body === 'string' ? enc.encode(body) : concat(body));
  };

  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] `
    + '/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> '
    + '/Contents 4 0 R >>',
  );
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add([
    enc.encode(
      `<< /Type /XObject /Subtype /Image /Width ${options.width} /Height ${options.height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\n`
      + 'stream\n',
    ),
    jpeg,
    enc.encode('\nendstream'),
  ]);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add(
    '<< /Type /Info'
    + ` /Title (${pdfText(options.title ?? 'LogicClass+ board')})`
    + ' /Producer (LogicClass+) >>',
  );

  // Assemble, recording where each object starts: the cross-reference table
  // is byte offsets, and a reader that cannot trust them cannot open the file.
  const head = enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const chunks: Uint8Array[] = [head];
  const offsets: number[] = [];
  let at = head.length;

  objects.forEach((body, i) => {
    const open = enc.encode(`${i + 1} 0 obj\n`);
    const close = enc.encode('\nendobj\n');
    offsets.push(at);
    chunks.push(open, body, close);
    at += open.length + body.length + close.length;
  });

  const xrefAt = at;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n`,
    `startxref\n${xrefAt}\n%%EOF\n`,
  ].join('');
  chunks.push(enc.encode(xref));

  return new Blob([concat(chunks) as BlobPart], { type: 'application/pdf' });
}

/** The same, straight from a canvas. */
export async function canvasToPdf(canvas: HTMLCanvasElement, options: {
  title?: string; caption?: string; quality?: number;
} = {}): Promise<Blob> {
  const jpeg = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', options.quality ?? 0.85);
  });
  if (!jpeg) throw new Error('The board could not be captured.');
  return jpegToPdf(new Uint8Array(await jpeg.arrayBuffer()), {
    width: canvas.width,
    height: canvas.height,
    ...options,
  });
}

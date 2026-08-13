import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  combinePages,
  storedFileName,
  UncombinablePageError,
} from '@/modules/documents/internal/combine-pages';

/**
 * Multi-page assembly — the step that turns several photographed pages into the one file
 * a document actually is (DESIGN.md §5, M1).
 *
 * Worth its own check because the failure is quiet and permanent: a document saved with
 * its second page silently dropped looks completely normal until the day someone needs
 * page two. Needs no database, no network and no fixtures — the images are built here.
 *
 * Run with: npm run verify:combine
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const CRC = [...Array(256).keys()].map((n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** A real, valid PNG built by hand, so the test carries no binary fixtures. */
function png(width: number, height: number): Uint8Array {
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // leading filter byte, then RGB pixels
    for (let x = 0; x < width; x++) row[1 + x * 3] = 200;
    rows.push(row);
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

async function pdfWithPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([200, 300]);
  return doc.save();
}

async function main() {
  const portrait = { data: png(60, 90), mimeType: 'image/png' };
  const landscape = { data: png(120, 60), mimeType: 'image/png' };

  // A single page must come back untouched — no re-encoding, no format change. Every
  // document scanned before this feature existed was stored as its original.
  const single = await combinePages([portrait]);
  check('single page keeps its mime type', single.mimeType === 'image/png', single.mimeType);
  check('single page keeps its extension', single.extension === 'png', single.extension);
  check(
    'single page bytes are identical, not re-encoded',
    Buffer.from(single.data).equals(Buffer.from(portrait.data)),
  );

  const merged = await combinePages([portrait, landscape]);
  check('two images produce a PDF', merged.mimeType === 'application/pdf', merged.mimeType);
  const mergedDoc = await PDFDocument.load(merged.data);
  check('two images produce two pages', mergedDoc.getPageCount() === 2, `${mergedDoc.getPageCount()}`);

  const [first, second] = mergedDoc.getPages();
  check('a portrait photo gets a portrait page', first.getHeight() > first.getWidth());
  check('a landscape photo gets a landscape page', second.getWidth() > second.getHeight());

  // An uploaded PDF may itself be multi-page; all of its pages have to join.
  const withPdf = await combinePages([
    portrait,
    { data: await pdfWithPages(3), mimeType: 'application/pdf' },
  ]);
  const withPdfDoc = await PDFDocument.load(withPdf.data);
  check('a 3-page PDF contributes all 3 pages', withPdfDoc.getPageCount() === 4, `${withPdfDoc.getPageCount()}`);

  // Page order is submission order — the reason the UI lets pages be reordered.
  const reversed = await PDFDocument.load((await combinePages([landscape, portrait])).data);
  check('pages keep the order they were given', reversed.getPages()[0].getWidth() > reversed.getPages()[0].getHeight());

  // pdf-lib embeds JPEG and PNG only. A GIF among several pages must surface as a typed
  // error the action can translate, not an opaque crash.
  let rejected: unknown;
  try {
    await combinePages([portrait, { data: png(10, 10), mimeType: 'image/gif' }]);
  } catch (err) {
    rejected = err;
  }
  check('an uncombinable page type is rejected by type', rejected instanceof UncombinablePageError);

  // ...but on its own it still passes straight through, exactly as before.
  const loneGif = await combinePages([{ data: png(10, 10), mimeType: 'image/gif' }]);
  check('a single GIF still uploads unchanged', loneGif.mimeType === 'image/gif', loneGif.mimeType);

  check(
    'stored name comes from the confirmed document name',
    storedFileName('סיכום ביקור אורתופד', 'pdf') === 'סיכום ביקור אורתופד.pdf',
    storedFileName('סיכום ביקור אורתופד', 'pdf'),
  );
  check(
    'stored name strips characters Drive and Windows reject',
    storedFileName('MRI 12/03 <שמאל>', 'pdf') === 'MRI 12 03 שמאל.pdf',
    storedFileName('MRI 12/03 <שמאל>', 'pdf'),
  );
  check('a blank name still yields a usable file name', storedFileName('   ', 'pdf') === 'מסמך.pdf');

  console.log(failures === 0 ? '\nAll combine checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

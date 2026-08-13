import { PDFDocument } from 'pdf-lib';
import { PDF_TYPE, type ScanFile } from '@/core/ports/llm';
import { extensionFor } from './media-types';

/**
 * Turning several photographed pages into the one file a document actually is.
 *
 * A two-page discharge letter is one document, and the person who owns it wants one thing
 * in their Drive folder that opens and shows both pages — not `letter-1.jpg` and
 * `letter-2.jpg` sitting next to each other with only the app's database knowing they are
 * related. Members read these files natively in Drive (DESIGN.md §3.4), so the artifact
 * has to make sense outside the app too.
 *
 * PDF is the obvious container, and it also means `documents.storage_ref` stays a single
 * opaque ref — no child table, no migration, and the rule in DESIGN.md §4 that a module
 * only ever sees one ref per document is preserved.
 */

/** A4 in PDF points. Phone photos are enormous in pixels; a page-sized page reads better. */
const A4_SHORT = 595.28;
const A4_LONG = 841.89;

/** pdf-lib embeds JPEG and PNG. GIF and WebP it cannot, which shapes the error below. */
const EMBEDDABLE = new Set(['image/jpeg', 'image/png']);

export class UncombinablePageError extends Error {
  constructor(readonly mimeType: string) {
    super(`Cannot combine a ${mimeType} page into a multi-page document.`);
    this.name = 'UncombinablePageError';
  }
}

export interface CombinedFile {
  data: Uint8Array;
  mimeType: string;
  /** Extension the caller should give the stored file, without the dot. */
  extension: string;
}

/**
 * One page in, the original bytes out — untouched.
 *
 * This is deliberate. Re-encoding a single photo into a PDF would cost quality and change
 * the file type for no gain, and every document scanned before this feature existed was
 * stored as its original. Only a genuine multi-page upload becomes a PDF.
 */
export async function combinePages(files: readonly ScanFile[]): Promise<CombinedFile> {
  if (files.length === 0) throw new Error('No pages to combine.');

  if (files.length === 1) {
    const [only] = files;
    return { data: only.data, mimeType: only.mimeType, extension: extensionFor(only.mimeType) };
  }

  for (const file of files) {
    if (file.mimeType !== PDF_TYPE && !EMBEDDABLE.has(file.mimeType)) {
      throw new UncombinablePageError(file.mimeType);
    }
  }

  const merged = await PDFDocument.create();

  for (const file of files) {
    if (file.mimeType === PDF_TYPE) {
      // An uploaded PDF may itself be multi-page; all of its pages join in order.
      const source = await PDFDocument.load(file.data, { ignoreEncryption: true });
      const copied = await merged.copyPages(source, source.getPageIndices());
      for (const page of copied) merged.addPage(page);
      continue;
    }

    const image =
      file.mimeType === 'image/jpeg'
        ? await merged.embedJpg(file.data)
        : await merged.embedPng(file.data);

    // Portrait or landscape to match the photo, then scale to fit with the aspect ratio
    // intact — a stretched medical document is a misleading one.
    const landscape = image.width > image.height;
    const pageWidth = landscape ? A4_LONG : A4_SHORT;
    const pageHeight = landscape ? A4_SHORT : A4_LONG;
    const page = merged.addPage([pageWidth, pageHeight]);

    const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;

    page.drawImage(image, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    });
  }

  return { data: await merged.save(), mimeType: PDF_TYPE, extension: 'pdf' };
}

/**
 * A stored name for the document, derived from what the user confirmed rather than from
 * the camera's `IMG_4821.jpg`. Drive shows this, so it should read like the document.
 */
export function storedFileName(documentName: string, extension: string): string {
  const cleaned = documentName
    .replace(/[\\/:*?"<>|]/g, ' ') // characters Drive and every desktop OS dislike
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${cleaned || 'מסמך'}.${extension}`;
}

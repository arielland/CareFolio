import { PDFDocument } from 'pdf-lib';
import { PDF_TYPE, type ScanFile } from '@/core/ports/llm';

/**
 * Handing the model page one, when page one is all it has been asked to read.
 *
 * The setting behind this (`spaces.ocr_first_page_only`, default on) exists because reading
 * a document costs a model call proportional to how many pages go into it, and a medical
 * document's identity — its date, its institution, its doctor, what kind of document it is —
 * is on the first page. Pages two through nine are the reference ranges, the printed consent
 * text, the appendix. Paying to read them changes the extracted fields rarely.
 *
 * What this touches is only what is *sent*. The document stored in Drive is always the whole
 * file: bounding the read must never bound the record.
 */

/**
 * The first page of a PDF as a PDF of its own, or the file unchanged when it is already one
 * page or is not a PDF at all.
 *
 * A photograph is one page by definition, so an image passes straight through — re-encoding
 * it would cost quality for nothing. A single-page PDF passes through for the same reason:
 * rebuilding it through pdf-lib would produce different bytes that say the same thing.
 *
 * `ignoreEncryption` matches `combinePages`, and for the same reason — kupah portals emit
 * PDFs with an empty owner password often enough that refusing them would be refusing real
 * documents.
 */
export async function firstPageOf(file: ScanFile): Promise<ScanFile> {
  if (file.mimeType !== PDF_TYPE) return file;

  const source = await PDFDocument.load(file.data, { ignoreEncryption: true });
  if (source.getPageCount() <= 1) return file;

  const single = await PDFDocument.create();
  const [page] = await single.copyPages(source, [0]);
  single.addPage(page);

  return { data: await single.save(), mimeType: PDF_TYPE };
}

/**
 * How many pages a scan actually consists of, which is not how many *files* arrived.
 *
 * Two photographs are two pages and a nine-page PDF is nine, so a document photographed page
 * by page and the same document exported from a portal count the same way. The screens use
 * this to say what was read and what was not, and "one file" would be a useless answer to
 * that question.
 *
 * A file that cannot be parsed counts as one page rather than throwing. This number is
 * reporting, never a decision: if the bytes are broken, the extraction call that follows is
 * where that should surface, with an error about the document rather than about a count.
 */
export async function pageCountOf(files: readonly ScanFile[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    if (file.mimeType !== PDF_TYPE) {
      total += 1;
      continue;
    }
    try {
      const pdf = await PDFDocument.load(file.data, { ignoreEncryption: true });
      total += pdf.getPageCount();
    } catch {
      total += 1;
    }
  }
  return total;
}

/**
 * The text a PDF already carries, before anybody pays a model to look at it.
 *
 * This is a port for one reason: `modules/documents` needs the answer, and the boundary
 * lint (rightly) refuses to let a module import an adapter. The implementation is pdfjs
 * today; it could be any library that can decode a content stream, and the module never
 * learns which.
 *
 * Unlike every other port here it takes no `AnyContext`. It reads bytes the caller already
 * holds, touches no provider, writes nothing, and logs nothing — there is no tenant for it
 * to be scoped to. Passing a context in would suggest otherwise.
 */

export interface PdfTextLayer {
  /** Every page that carried text, joined in order. Empty for a scanned PDF. */
  text: string;
  /**
   * The same text, still separated by page.
   *
   * The whole reason this is here rather than derived: a space set to read only the first
   * page needs page one exactly, and splitting a joined string back apart on a blank line
   * would be a guess about a document's own formatting.
   */
  pages: readonly string[];
  /** Pages carrying enough characters to count, and the total, so the caller can decide. */
  pagesWithText: number;
  pageCount: number;
  /**
   * Whether the characters are actually characters. False means the file has a text layer
   * that decodes to nonsense, which is a real and silently destructive failure — see the
   * adapter for the one that was found in this app's own test set.
   */
  decodable: boolean;
}

export interface PdfTextPort {
  readTextLayer(data: Uint8Array): Promise<PdfTextLayer>;
}

/**
 * Does this PDF's own text layer carry the document, or only a scanner's footer?
 *
 * Here rather than in the adapter because it is a *policy* — how much text is enough to
 * trust — and the same rule has to hold for the bulk import in the app and the one in
 * `scripts/import-documents.mts`. The adapter reports; this decides.
 *
 * Most pages must carry text before the file is trusted to have read itself. A scanned
 * bundle with one generated cover page would otherwise return the cover and silently drop
 * the twelve pages that matter — which reads as success.
 */
export function hasUsableTextLayer(layer: PdfTextLayer): boolean {
  if (!layer.decodable) return false;
  if (!layer.text.trim()) return false;
  return layer.pagesWithText >= Math.ceil(layer.pageCount * 0.6);
}

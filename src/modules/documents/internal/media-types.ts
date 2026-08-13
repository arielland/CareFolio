/**
 * What a document may be stored and served as.
 *
 * This is a security boundary, not a convenience map. `/api/files/[id]` streams these bytes
 * from the app's own origin, and the browser decides what to do with them from the
 * `Content-Type` the response carries. A type outside this set — `text/html`,
 * `image/svg+xml` — would therefore execute as script in the session of every member who
 * opened the document, with access to every server action and every other file that member
 * can reach. The list is an allowlist of types that render as *content* and cannot carry a
 * same-origin payload.
 *
 * Deliberately distinct from `isSupportedScanType` in `core/ports/llm.ts`, which answers a
 * different question: what the model can read. HEIC is storable and unreadable, GIF is
 * readable and uncombinable. The two lists overlap without being the same one, and
 * collapsing them would mean widening one to suit the other.
 *
 * The extension travels with the type because the two must agree: `storedFileName` puts it
 * on the file in Drive, where a member opens it natively with no Content-Type in sight, and
 * a `.bin` that is really a PDF is a document nobody can open.
 */
export const STORABLE_DOCUMENT_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;

export type StorableDocumentType = keyof typeof STORABLE_DOCUMENT_TYPES;

/**
 * `image/jpeg; charset=binary` is still an image/jpeg. Browsers and Drive both attach
 * parameters freely, so every comparison here happens on the bare type.
 */
export function normalizeMediaType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * `Object.hasOwn` rather than the `in` operator, which walks the prototype chain and would
 * therefore answer yes to `constructor`, `toString` and `__proto__`. That is not a
 * hypothetical tidiness point: `__proto__` would resolve to `Object.prototype` below and
 * hand back an object where the extension should be. Caught by scripts/verify-media-types.mts.
 */
export function isStorableDocumentType(mimeType: string): boolean {
  return Object.hasOwn(STORABLE_DOCUMENT_TYPES, normalizeMediaType(mimeType));
}

/**
 * The exact type to put on the wire, chosen from the allowlist rather than echoed back from
 * the row. A value that reached the database by any other path — an older row, a future
 * import, a bug — cannot then pick the `Content-Type` of a response served from this app's
 * origin. `null` means "refuse to name it", and the caller serves it as an opaque download.
 */
export function servableTypeFor(mimeType: string): StorableDocumentType | null {
  const normalized = normalizeMediaType(mimeType);
  return isStorableDocumentType(normalized) ? (normalized as StorableDocumentType) : null;
}

/**
 * The type a file name claims, for the import path only.
 *
 * A provider is the authority on what its bytes are, and this is the fallback for when it
 * declines to say: Drive answers `application/octet-stream` for plenty of perfectly ordinary
 * PDFs, and refusing those would make the import look broken to someone whose folder is fine.
 *
 * It is a *narrowing* fallback, never a widening one — it can only ever return a member of
 * the allowlist above or null, so a `.html` in the folder resolves to null and is refused
 * exactly as it would be on the strength of its content type.
 */
export function typeForFileName(fileName: string): StorableDocumentType | null {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!extension) return null;
  // `.jpeg` and `.jpg` are the same type; the table is keyed the other way round, so this
  // walks it rather than inverting it and losing that.
  const alias = extension === 'jpeg' ? 'jpg' : extension;
  const found = (Object.keys(STORABLE_DOCUMENT_TYPES) as StorableDocumentType[]).find(
    (type) => STORABLE_DOCUMENT_TYPES[type] === alias,
  );
  return found ?? null;
}

export function extensionFor(mimeType: string): string {
  const normalized = normalizeMediaType(mimeType);
  return isStorableDocumentType(normalized)
    ? STORABLE_DOCUMENT_TYPES[normalized as StorableDocumentType]
    : 'bin';
}

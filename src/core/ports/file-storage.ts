import type { AnyContext } from '@/core/context/space-context';
import type { StorageProvider } from '@/core/domain/types';

/**
 * Blob storage. Google Drive today; the point of this interface is that swapping it
 * later touches one adapter and one line of the composition root (DESIGN.md §4).
 */

export interface FileBlob {
  data: Uint8Array | ReadableStream<Uint8Array>;
  mimeType: string;
  sizeBytes?: number;
}

export interface StoredFile {
  /** Opaque provider id. Stored in the database, never parsed or pattern-matched. */
  ref: string;
  provider: StorageProvider;
  webUrl?: string;
}

export interface FileStoragePort {
  /**
   * Context is required on every call because the adapter resolves *which* credential
   * to use from it: space → admin user → stored Google token (DESIGN.md §3.4).
   */
  upload(ctx: AnyContext, file: FileBlob, opts: { folder?: string; name: string }): Promise<StoredFile>;
  download(ctx: AnyContext, ref: string): Promise<FileBlob>;
  delete(ctx: AnyContext, ref: string): Promise<void>;
  getShareableLink(ctx: AnyContext, ref: string): Promise<string>;
  /** Logical path, e.g. "HealthApp/2026/Imaging". The adapter maps it to provider concepts. */
  ensureFolder(ctx: AnyContext, path: string): Promise<string>;
}

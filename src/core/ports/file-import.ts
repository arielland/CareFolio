import type { AnyContext } from '@/core/context/space-context';
import type { FileBlob } from './file-storage';

/**
 * Reading a folder of documents that already exists somewhere else, so it can be brought in.
 *
 * Deliberately **not** part of `FileStoragePort`. That port is where this app *keeps* things:
 * it uploads, downloads by an opaque ref it issued itself, and never enumerates. This one
 * only ever reads, and reads somewhere the app did not create — a folder in the admin's own
 * Drive that predates the app entirely. Same provider today, opposite direction of trust, so
 * they are separate interfaces and separately granted.
 *
 * The consequence of that difference is the whole reason to be careful here: storage works
 * under `drive.file`, which cannot see a file this app did not create. Enumerating somebody's
 * existing folder cannot, so the Google implementation rides on a wider grant that a space
 * has to switch on deliberately (`spaces.drive_import_enabled`, off by default) and that is
 * only then requested, when an admin actually opens the import screen (DESIGN.md §11).
 *
 * Turning that switch back off is what stops the app using it. It does not un-grant anything
 * at Google, which removes an app's access as a whole rather than one permission at a time —
 * see `DRIVE_IMPORT_SCOPE` in `adapters/google/oauth.ts`.
 */

export interface ImportFolder {
  id: string;
  name: string;
}

export interface ImportFile {
  id: string;
  name: string;
  mimeType: string;
  /** Null when the provider does not report one — a Google-native doc, for instance. */
  sizeBytes: number | null;
}

export interface ImportSourcePort {
  /** Sub-folders of `parentId`, or of the account's root when it is null. */
  listFolders(ctx: AnyContext, parentId: string | null): Promise<ImportFolder[]>;

  /**
   * Files directly inside a folder. Not recursive: a caller importing a folder should see
   * exactly the list it is about to spend money on, and a tree hides that.
   */
  listFiles(ctx: AnyContext, folderId: string): Promise<ImportFile[]>;

  /** The bytes of one file, by the id the listings returned. */
  read(ctx: AnyContext, fileId: string): Promise<FileBlob>;
}

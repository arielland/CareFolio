import type { AnyContext } from '@/core/context/space-context';
import type { FileBlob } from '@/core/ports/file-storage';
import type { ImportFile, ImportFolder, ImportSourcePort } from '@/core/ports/file-import';
import { log } from '@/core/logging/logger';
import { DRIVE_IMPORT_SCOPE } from './oauth';
import { getGoogleAccessToken } from './tokens';

/**
 * Drive behind ImportSourcePort — the admin's *existing* folders, read-only (DESIGN.md §4).
 *
 * A separate class from `GoogleDriveAdapter` rather than four more methods on it, because
 * they run on different grants and that difference should be visible in the type system
 * rather than buried in a scope constant halfway down a file. Every call here resolves
 * `DRIVE_IMPORT_SCOPE`; every call there resolves `DRIVE_SCOPE`. A space with storage
 * connected and no import grant gets a `GoogleNotConnectedError('missing_scope')` from this
 * class and keeps working normally through the other.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * How much of a folder one listing will walk.
 *
 * Drive pages at 100 by default and this asks for 1000 at a time, so the cap is four round
 * trips, not four thousand. It exists because a listing is what the import screen shows and
 * what the user then agrees to spend a model call per file on: a folder large enough to need
 * a fifth page is large enough that the honest thing is to say so and let them narrow it.
 */
const MAX_PAGES = 4;
const PAGE_SIZE = 1000;

async function driveFetch(token: string, url: string): Promise<Response> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    // Drive quotes the offending file name back in its error bodies, which here means a
    // medical document's name — health content that must not reach a log (DESIGN.md §7.1).
    throw new Error(`Drive API GET failed with ${response.status}`);
  }
  return response;
}

/**
 * `'…' in parents` takes a quoted id, and a query is a string this code builds. Ids come
 * from Drive itself so an injected quote is not a live risk; escaping is a line of code and
 * removes the need for anyone to re-derive that.
 */
const quote = (value: string) => `'${value.replace(/'/g, "\\'")}'`;

export class GoogleDriveImport implements ImportSourcePort {
  async listFolders(ctx: AnyContext, parentId: string | null): Promise<ImportFolder[]> {
    const rows = await this.query(ctx, [
      `mimeType = ${quote(FOLDER_MIME)}`,
      `${quote(parentId ?? 'root')} in parents`,
      'trashed = false',
    ]);

    return rows
      .map((row) => ({ id: row.id, name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  async listFiles(ctx: AnyContext, folderId: string): Promise<ImportFile[]> {
    const rows = await this.query(ctx, [
      `mimeType != ${quote(FOLDER_MIME)}`,
      `${quote(folderId)} in parents`,
      'trashed = false',
    ]);

    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        // Drive reports no size for its own native types (Docs, Sheets). Those cannot be
        // imported anyway — the caller screens on `mimeType` — but the field has to be
        // honest rather than zero, which would read as an empty file.
        sizeBytes: row.size ? Number(row.size) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  async read(ctx: AnyContext, fileId: string): Promise<FileBlob> {
    const token = await getGoogleAccessToken(ctx, DRIVE_IMPORT_SCOPE);
    const response = await driveFetch(token, `${DRIVE_API}/files/${fileId}?alt=media`);
    const data = new Uint8Array(await response.arrayBuffer());

    log.info('drive.import.read', {
      module: 'adapters/google',
      provider: 'google',
      operation: 'files.get',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'success',
    });

    return {
      data,
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      sizeBytes: data.length,
    };
  }

  private async query(
    ctx: AnyContext,
    conditions: readonly string[],
  ): Promise<Array<{ id: string; name: string; mimeType: string; size?: string }>> {
    const token = await getGoogleAccessToken(ctx, DRIVE_IMPORT_SCOPE);
    const rows: Array<{ id: string; name: string; mimeType: string; size?: string }> = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        q: conditions.join(' and '),
        fields: 'nextPageToken, files(id,name,mimeType,size)',
        pageSize: String(PAGE_SIZE),
        orderBy: 'name',
        // Shared drives are a different sharing model with different consequences for who
        // can see what; this app imports from the admin's own Drive and says so.
        supportsAllDrives: 'false',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await driveFetch(token, `${DRIVE_API}/files?${params.toString()}`);
      const json = (await response.json()) as {
        files: Array<{ id: string; name: string; mimeType: string; size?: string }>;
        nextPageToken?: string;
      };

      rows.push(...json.files);
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }

    return rows;
  }
}

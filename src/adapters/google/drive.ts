import type { AnyContext } from '@/core/context/space-context';
import { readInSpace } from '@/core/db/unit-of-work';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import type { NativeSharingCapable } from '@/core/ports/native-sharing';
import { errorFields, log, timed } from '@/core/logging/logger';
import { DRIVE_SCOPE } from './oauth';
import { getGoogleAccessToken } from './tokens';

/**
 * Google Drive behind FileStoragePort (DESIGN.md §4).
 *
 * Uses the raw REST API rather than googleapis: the four calls we need are small, and
 * the official client would pull a very large dependency into every serverless bundle
 * for no gain.
 *
 * Everything here operates with the space admin's credential, resolved per call — so
 * this adapter is the only place that knows storage is credential-scoped at all. The
 * modules above it just see `ref` strings.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function driveFetch(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    // Drive error bodies quote the offending file name back at you, which for this app
    // means a document title — health content that must not reach logs (DESIGN.md §7.1).
    throw new Error(`Drive API ${init.method ?? 'GET'} failed with ${response.status}`);
  }
  return response;
}

export class GoogleDriveAdapter implements FileStoragePort, NativeSharingCapable {
  async ensureFolder(ctx: AnyContext, path: string): Promise<string> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    let parentId = 'root';

    // Walk the logical path segment by segment, creating what's missing. The caller
    // passes "HealthApp/2026/Imaging"; Drive only knows about parent/child ids.
    for (const segment of path.split('/').filter(Boolean)) {
      parentId = await this.ensureChildFolder(token, parentId, segment);
    }
    return parentId;
  }

  private async ensureChildFolder(token: string, parentId: string, name: string): Promise<string> {
    const query = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `mimeType = '${FOLDER_MIME}'`,
      `'${parentId}' in parents`,
      'trashed = false',
    ].join(' and ');

    const search = await driveFetch(
      token,
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
    );
    const found = (await search.json()) as { files: Array<{ id: string }> };
    if (found.files.length > 0) return found.files[0].id;

    const created = await driveFetch(token, `${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return ((await created.json()) as { id: string }).id;
  }

  async upload(
    ctx: AnyContext,
    file: FileBlob,
    opts: { folder?: string; name: string },
  ): Promise<StoredFile> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    const parentId = opts.folder
      ? await this.ensureFolder(ctx, opts.folder)
      : await this.spaceRootFolder(ctx);

    const metadata = { name: opts.name, parents: [parentId] };
    const boundary = `hb-${crypto.randomUUID()}`;
    const bytes =
      file.data instanceof Uint8Array ? file.data : new Uint8Array(await new Response(file.data).arrayBuffer());

    // Multipart upload: metadata part, then the bytes, in one request.
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const response = await timed(
      'drive.upload',
      { module: 'adapters/google', provider: 'google', operation: 'upload', spaceId: ctx.spaceId, requestId: ctx.requestId },
      () =>
        driveFetch(token, `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        }),
    );

    const json = (await response.json()) as { id: string; webViewLink?: string };
    return { ref: json.id, provider: 'google-drive', webUrl: json.webViewLink };
  }

  async download(ctx: AnyContext, ref: string): Promise<FileBlob> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    const response = await driveFetch(token, `${DRIVE_API}/files/${ref}?alt=media`);
    const data = new Uint8Array(await response.arrayBuffer());
    return {
      data,
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      sizeBytes: data.length,
    };
  }

  async delete(ctx: AnyContext, ref: string): Promise<void> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    await driveFetch(token, `${DRIVE_API}/files/${ref}`, { method: 'DELETE' });
  }

  async getShareableLink(ctx: AnyContext, ref: string): Promise<string> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    const response = await driveFetch(token, `${DRIVE_API}/files/${ref}?fields=webViewLink`);
    const json = (await response.json()) as { webViewLink?: string };
    if (!json.webViewLink) throw new Error('Drive returned no web link for this file.');
    return json.webViewLink;
  }

  /* ------------------------------------------------ NativeSharingCapable */

  async grantAccess(
    ctx: AnyContext,
    principalEmail: string,
    level: 'reader' | 'writer',
  ): Promise<string> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    const folderId = await this.spaceRootFolder(ctx);
    const response = await driveFetch(
      token,
      // sendNotificationEmail=false: the app invites members itself; a second mail
      // from Drive about a folder they didn't ask for is confusing.
      `${DRIVE_API}/files/${folderId}/permissions?fields=id&sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: level, emailAddress: principalEmail }),
      },
    );
    const json = (await response.json()) as { id: string };
    log.info('drive.access.granted', {
      module: 'adapters/google', provider: 'google', operation: 'permissions.create',
      spaceId: ctx.spaceId, requestId: ctx.requestId, outcome: 'success',
    });
    return json.id;
  }

  async revokeAccess(ctx: AnyContext, permissionId: string): Promise<void> {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    const folderId = await this.spaceRootFolder(ctx);
    await driveFetch(token, `${DRIVE_API}/files/${folderId}/permissions/${permissionId}`, {
      method: 'DELETE',
    });
  }

  async listGrants(ctx: AnyContext) {
    const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
    const folderId = await this.spaceRootFolder(ctx);
    const response = await driveFetch(
      token,
      `${DRIVE_API}/files/${folderId}/permissions?fields=permissions(id,emailAddress,role)`,
    );
    const json = (await response.json()) as {
      permissions: Array<{ id: string; emailAddress?: string; role: string }>;
    };
    return json.permissions.map((p) => ({
      permissionId: p.id,
      email: p.emailAddress ?? '',
      level: p.role,
    }));
  }

  private async spaceRootFolder(ctx: AnyContext): Promise<string> {
    const space = await readInSpace(ctx, (repos) => repos.space.get());
    if (space?.driveFolderId) return space.driveFolderId;
    throw new Error('This space has no Drive folder yet — connect Google Drive first.');
  }
}

export function isGoogleNotConnected(err: unknown): boolean {
  return err instanceof Error && err.name === 'GoogleNotConnectedError';
}

export { errorFields };

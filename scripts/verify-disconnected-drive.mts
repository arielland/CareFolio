import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { accounts, users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
// Reached directly, which a module may not do and a script may: putting the *real* adapter
// back is the entire point of the second half of this check.
import { GoogleDriveAdapter } from '@/adapters/google/drive';
import type { SpaceContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import { readDocumentFile, saveDocument } from '@/modules/documents';
import { sharingReadiness } from '@/modules/identity';

/**
 * What a space that cannot reach its own Drive says, instead of failing opaquely.
 *
 * The state is ordinary and this app produces it on purpose: the SEC-19 rotation handed every
 * Google grant back, so until an admin reconnects, the account row carries the sign-in scopes
 * and nothing else. `getGoogleAccessToken` refuses with `missing_scope`, which reached the
 * user as a 500 and a sentence that named no cause — the file screen offered "הצגת הקובץ",
 * the tab showed a failed request, and the fix was one button on a different screen.
 *
 * Three things are checked, and they are the three links in that chain:
 *
 *   - `sharingReadiness().storage` is false in exactly this state and true once the grant is
 *     back. That single boolean is what the file screen draws its buttons from.
 *   - `readDocumentFile` against the **real** Drive adapter throws `GoogleNotConnectedError`.
 *     No network is involved: the scope check precedes the token refresh, so this exercises
 *     the production path up to the point where it gives up.
 *   - `err.name` is the exact string the route matches to answer 503 rather than 500. It is
 *     matched by name because the error class lives behind the ports, and a rename would
 *     otherwise turn the helpful answer back into a generic one with nothing failing.
 *
 * Run with: npm run verify:disconnected-drive
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** What a plain Google sign-in leaves behind, and all it leaves behind. */
const SIGN_IN_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';

class FakeStorage implements FileStoragePort {
  private next = 0;
  async upload(): Promise<StoredFile> {
    return { ref: `ref-${++this.next}`, provider: 'google-drive' };
  }
  async download(): Promise<FileBlob> { return { data: new Uint8Array(), mimeType: 'application/pdf' }; }
  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> { return 'https://example.test'; }
  async ensureFolder(): Promise<string> { return 'folder'; }
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

async function setScope(userId: string, scope: string) {
  await db.update(accounts).set({ scope })
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')));
}

async function main() {
  const stamp = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ email: `drive-${stamp}@example.test`, name: 'מנהל/ת' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };

  // The row a plain Google sign-in creates: an identity link and the three sign-in scopes.
  await db.insert(accounts).values({
    userId: owner.id,
    type: 'oidc',
    provider: 'google',
    providerAccountId: `google-${stamp}`,
    scope: SIGN_IN_SCOPES,
    refresh_token: 'not-a-real-token',
  });

  try {
    /* --- the gate the file screen draws its buttons from ------------------------- */

    // A folder from an earlier connection, which is the real shape of this: the documents
    // were filed when the grant existed and are still sitting in that folder.
    await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

    const disconnected = await sharingReadiness(ctx);
    check('a space whose grant was handed back reads as disconnected', disconnected.storage === false,
      'exactly the state the rotation leaves behind');

    await setScope(owner.id, `${SIGN_IN_SCOPES} ${DRIVE_SCOPE}`);
    const reconnected = await sharingReadiness(ctx);
    check('and as connected once the Drive scope is back', reconnected.storage === true);

    // Both halves are required, and the folder is the half that survives a revoke — so the
    // scope going missing has to be enough on its own to close the buttons.
    await setScope(owner.id, SIGN_IN_SCOPES);
    check('the scope alone decides it, with the folder still recorded',
      (await sharingReadiness(ctx)).storage === false);

    /* --- what the real adapter does in that state -------------------------------- */

    // Saved through a fake so the fixture exists, then read back through the real adapter.
    __setPorts({ fileStorage: new FakeStorage() });
    const document = await saveDocument(ctx, {
      fields: {
        name: 'מסמך', docType: null, docDate: null, hospital: null, doctor: null,
        tags: [], actionRequired: false, actionSummary: null, fullText: 'טקסט',
      },
      file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
    });

    // Back to the real GoogleDriveAdapter. Nothing reaches Google: `getGoogleAccessToken`
    // checks the scope before it would refresh a token.
    __setPorts({ fileStorage: new GoogleDriveAdapter() });

    let thrown: unknown;
    try {
      await readDocumentFile(ctx, document.id);
    } catch (err) {
      thrown = err;
    }

    check('reading the file refuses rather than hanging or 500ing', thrown !== undefined);
    check('and the reason is the missing grant, not a lost document',
      (thrown as { reason?: string })?.reason === 'missing_scope',
      String((thrown as { reason?: string })?.reason));

    // The literal string in the route's catch. If someone renames the class, the route
    // silently falls back to a generic 500 and no test anywhere else notices.
    check('the error carries the name /api/files/[id] matches on',
      thrown instanceof Error && thrown.name === 'GoogleNotConnectedError',
      thrown instanceof Error ? thrown.name : 'not an Error');
    check('which is the same string the Vercel log showed as errorType',
      (thrown as Error).name === 'GoogleNotConnectedError');

    /* --- and the document itself is fine ----------------------------------------- */

    // The point of the panel's "הקובץ עצמו שמור": nothing about this state touched the row
    // or the bytes. Only the app's permission to fetch them is gone.
    __setPorts({ fileStorage: new FakeStorage() });
    const stillThere = await readDocumentFile(ctx, document.id);
    check('the same document reads fine the moment storage answers again',
      stillThere.fileName.includes('מסמך'), stillThere.fileName);
  } finally {
    // Left behind rather than cleaned up, as every other verify script leaves its fixtures:
    // `spaces.admin_user_id` references this row without a cascade, so removing it would mean
    // tearing down the space first — and a probe that deletes spaces to tidy up is one bad
    // `where` clause away from being the worst script in the repository.
    __setPorts({ fileStorage: new FakeStorage() });
  }

  console.log(`\n${failures === 0 ? 'All disconnected-Drive checks passed.' : `${failures} check(s) FAILED.`}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await raw.end();
    process.exit(failures === 0 ? 0 : 1);
  });

import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { AnyContext, SpaceContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import type { ImportFile, ImportFolder, ImportSourcePort } from '@/core/ports/file-import';
import type {
  ExtractionRequest,
  LlmPort,
  LlmResult,
  ScanFile,
  TextExtractionRequest,
} from '@/core/ports/llm';
import {
  DEFAULT_DRIVE_IMPORT_ENABLED,
  DEFAULT_FIRST_PAGE_ONLY,
  extractFromScan,
  getSpaceSettings,
  importDocument,
  importFromSource,
  importReadiness,
  listImportFiles,
  listImportFolders,
  setDriveImport,
  setScanScope,
} from '@/modules/documents';

/**
 * The scan scope setting, and the bulk import that obeys it.
 *
 * What is worth automating here is everything that is invisible when it goes wrong. A space
 * set to read first pages only still *works* if the setting is ignored — it just quietly
 * costs nine times as much and nobody finds out from the screen. And a document whose first
 * page was read has to still be stored whole, which is exactly the kind of thing a
 * page-slicing optimisation breaks without any test noticing.
 *
 * So the checks below open the bytes that reached the model and count their pages, rather
 * than trusting a flag: `PDFDocument.load(...).getPageCount()` on what the fake LLM was
 * handed is the only assertion that cannot be satisfied by the code merely intending to be
 * correct.
 *
 * Drive and the model are fakes. Real: the database, RLS, the module, the pdfjs text-layer
 * adapter, and pdf-lib's page slicing — which is where the mistakes would be.
 *
 * Run with: npm run verify:scan-scope
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

class FakeStorage implements FileStoragePort {
  uploads: FileBlob[] = [];
  private files = new Map<string, FileBlob>();

  async upload(_ctx: unknown, file: FileBlob): Promise<StoredFile> {
    this.uploads.push(file);
    const ref = `ref-${this.uploads.length}`;
    this.files.set(ref, file);
    return { ref, provider: 'google-drive' };
  }
  async download(_ctx: unknown, ref: string): Promise<FileBlob> {
    const found = this.files.get(ref);
    if (!found) throw new Error('no such file');
    return found;
  }
  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> { return 'https://example.test'; }
  async ensureFolder(): Promise<string> { return 'folder'; }
}

/** Keeps what it was handed, which is the only way to check what was actually sent. */
class RecordingLlm implements LlmPort {
  documentCalls: ScanFile[][] = [];
  textCalls: string[] = [];

  async extractFromDocument<T>(_ctx: AnyContext, request: ExtractionRequest): Promise<LlmResult<T>> {
    this.documentCalls.push([...request.files]);
    return this.reply('נקרא כמסמך') as LlmResult<T>;
  }

  async extractFromText<T>(_ctx: AnyContext, request: TextExtractionRequest): Promise<LlmResult<T>> {
    this.textCalls.push(request.text);
    return this.reply(request.text) as LlmResult<T>;
  }

  async complete(): Promise<LlmResult<string>> {
    return { value: '', usage: { model: 'fake', tokensIn: 0, tokensOut: 0 } };
  }

  get lastDocumentCall() { return this.documentCalls.at(-1) ?? []; }

  private reply(fullText: string) {
    return {
      value: {
        name: 'מסמך בדיקה',
        docType: 'תוצאות מעבדה',
        docDate: '2026-05-04',
        hospital: 'כללית',
        doctor: 'ד"ר לוי',
        tags: ['בדיקה'],
        actionRequired: false,
        actionSummary: null,
        fullText,
      },
      usage: { model: 'fake', tokensIn: 0, tokensOut: 0 },
    };
  }
}

/** A folder that behaves like Drive's, so the admin check and the listing can be exercised. */
class FakeImportSource implements ImportSourcePort {
  reads = 0;
  constructor(private readonly files: Array<ImportFile & { data: Uint8Array }>) {}

  async listFolders(_ctx: AnyContext, parentId: string | null): Promise<ImportFolder[]> {
    return parentId === null ? [{ id: 'folder-1', name: 'מסמכים רפואיים' }] : [];
  }
  async listFiles(): Promise<ImportFile[]> {
    return this.files.map(({ id, name, mimeType, sizeBytes }) => ({ id, name, mimeType, sizeBytes }));
  }
  async read(_ctx: AnyContext, fileId: string): Promise<FileBlob> {
    const found = this.files.find((file) => file.id === fileId);
    if (!found) throw new Error('no such file');
    this.reads++;
    return { data: found.data, mimeType: found.mimeType, sizeBytes: found.data.length };
  }
}

/** A PDF of `pageCount` pages, each carrying enough real text to count as a text layer. */
async function textPdf(pageCount: number, marker: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pageCount; p++) {
    const page = pdf.addPage([600, 800]);
    for (let line = 0; line < 10; line++) {
      page.drawText(`${marker} PAGE ${p} line ${line} with enough characters to count`, {
        x: 40, y: 750 - line * 24, size: 11, font,
      });
    }
  }
  return pdf.save();
}

/** No text anywhere — the stand-in for a scan, which has to reach the vision path. */
async function scannedPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let p = 0; p < pageCount; p++) {
    pdf.addPage([600, 800]).drawRectangle({ x: 50, y: 50, width: 500, height: 700 });
  }
  return pdf.save();
}

const pagesIn = async (data: Uint8Array) =>
  (await PDFDocument.load(data, { ignoreEncryption: true })).getPageCount();

async function main() {
  const storage = new FakeStorage();
  const llm = new RecordingLlm();

  const stamp = randomUUID().slice(0, 8);
  const [owner] = await db
    .insert(users)
    .values({ email: `scope-${stamp}@example.test`, name: 'בעלים' })
    .returning();
  const [other] = await db
    .insert(users)
    .values({ email: `scope-other-${stamp}@example.test`, name: 'שותף' })
    .returning();

  const { spaceId } = await createSpaceWithAdmin({
    name: 'scope', subjectName: 'אמא', adminUserId: owner.id,
  });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const threePageScan = await scannedPdf(3);
  const threePageText = await textPdf(3, 'BLOOD');

  const source = new FakeImportSource([
    { id: 'file-1', name: 'lab.pdf', mimeType: 'application/pdf', sizeBytes: threePageText.length, data: threePageText },
    { id: 'file-2', name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 12, data: new Uint8Array([1, 2]) },
  ]);
  __setPorts({ fileStorage: storage, llm, importSource: source });

  /* --- the default ------------------------------------------------------------- */

  const initial = await getSpaceSettings(ctx);
  check('a new space reads first pages only by default', initial.firstPageOnly === true,
    `firstPageOnly=${initial.firstPageOnly}`);
  check('and the module default agrees with the column default', DEFAULT_FIRST_PAGE_ONLY === true);
  check('and importing from Drive is off until somebody turns it on',
    initial.driveImportEnabled === false && DEFAULT_DRIVE_IMPORT_ENABLED === false,
    `driveImportEnabled=${initial.driveImportEnabled}`);

  /* --- the Drive option is a gate, not a hidden button --------------------------- */

  const blockedList = await listImportFolders(ctx, null)
    .then(() => null)
    .catch((err: Error & { reason?: string }) => err.reason ?? err.name);
  check('while it is off, even the admin cannot list a folder',
    blockedList === 'drive_import_disabled', blockedList ?? 'it succeeded');

  const blockedRead = await importFromSource(ctx, { fileId: 'file-1', fileName: 'lab.pdf' })
    .then(() => null)
    .catch((err: Error & { reason?: string }) => err.reason ?? err.name);
  check('and cannot read a file out of one', blockedRead === 'drive_import_disabled',
    blockedRead ?? 'it succeeded');
  check('and nothing was fetched from the provider', source.reads === 0, `${source.reads} read(s)`);

  const readinessOff = await importReadiness(ctx);
  check('the screen is told it is off rather than being told it failed',
    readinessOff.enabled === false && readinessOff.allowed === true,
    `enabled=${readinessOff.enabled} allowed=${readinessOff.allowed}`);

  const notOwner: SpaceContext = {
    spaceId, userId: other.id, role: 'editor', requestId: randomUUID(),
  };
  const refusedToggle = await setDriveImport(notOwner, true)
    .then(() => null)
    .catch((err: Error) => err.name);
  check('an editor cannot turn it on', refusedToggle === 'ForbiddenError',
    refusedToggle ?? 'it succeeded');
  check('and it is still off', (await getSpaceSettings(ctx)).driveImportEnabled === false);

  await setDriveImport(ctx, true);
  check('the owner turning it on persists',
    (await getSpaceSettings(ctx)).driveImportEnabled === true);

  // Local import is deliberately outside the gate: uploading files from your own computer
  // uses nobody's Google grant, so it must work whichever way the switch is set.
  await setDriveImport(ctx, false);
  const localWhileOff = await importDocument(ctx, {
    data: await textPdf(1, 'LOCAL'), mimeType: 'application/pdf', fileName: 'local.pdf',
  });
  check('importing a local file works while the Drive option is off',
    localWhileOff.status === 'imported', localWhileOff.status);
  await setDriveImport(ctx, true);

  /* --- what the model is actually handed ---------------------------------------- */

  const limited = await extractFromScan(ctx, [{ data: threePageScan, mimeType: 'application/pdf' }]);
  const sentWhenLimited = llm.lastDocumentCall;

  check('a three-page scan reaches the model as one file', sentWhenLimited.length === 1,
    `${sentWhenLimited.length} file(s)`);
  check('and that file is one page long',
    (await pagesIn(sentWhenLimited[0].data)) === 1,
    `${await pagesIn(sentWhenLimited[0].data)} page(s)`);
  check('the reading reports how much was read of how much',
    limited.pageCount === 3 && limited.pagesRead === 1,
    `read ${limited.pagesRead} of ${limited.pageCount}`);
  check('and the file kept for storage is still the whole document',
    (await pagesIn(limited.combined.data)) === 3,
    `${await pagesIn(limited.combined.data)} page(s)`);

  /* --- and what it is handed with the setting off -------------------------------- */

  await setScanScope(ctx, false);
  const after = await getSpaceSettings(ctx);
  check('turning the setting off persists', after.firstPageOnly === false);

  const whole = await extractFromScan(ctx, [{ data: threePageScan, mimeType: 'application/pdf' }]);
  check('with it off the whole document goes to the model',
    (await pagesIn(llm.lastDocumentCall[0].data)) === 3,
    `${await pagesIn(llm.lastDocumentCall[0].data)} page(s)`);
  check('and it reports every page as read',
    whole.pageCount === 3 && whole.pagesRead === 3,
    `read ${whole.pagesRead} of ${whole.pageCount}`);

  /*
   * Two photographed pages are two pages of one document, and the ones that are *not* read
   * still have to end up in the stored file. Real PNG bytes rather than a stub, because
   * `combinePages` embeds them for real and a stub would make this check pass by erroring.
   */
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const photos = await extractFromScan(
    ctx,
    [{ data: png, mimeType: 'image/png' }, { data: png, mimeType: 'image/png' }],
    { firstPageOnly: true },
  );
  check('two photographs count as two pages, and only one is read',
    photos.pageCount === 2 && photos.pagesRead === 1,
    `read ${photos.pagesRead} of ${photos.pageCount}`);
  check('only the first photograph reaches the model',
    llm.lastDocumentCall.length === 1 && llm.lastDocumentCall[0].mimeType === 'image/png',
    `${llm.lastDocumentCall.length} file(s)`);
  check('and both are combined into the two-page PDF that gets stored',
    (await pagesIn(photos.combined.data)) === 2,
    `${await pagesIn(photos.combined.data)} page(s)`);

  await setScanScope(ctx, true);

  /* --- the import: routing, scope, and duplicates -------------------------------- */

  const textCallsBefore = llm.textCalls.length;
  const first = await importDocument(ctx, {
    data: threePageText, mimeType: 'application/pdf', fileName: 'lab.pdf',
  });

  check('a PDF carrying its own text never reaches the vision model',
    first.status === 'imported' && first.route === 'text-layer',
    first.status === 'imported' ? first.route : first.status);
  check('and only the first page of that text is sent',
    llm.textCalls.length === textCallsBefore + 1 &&
      llm.textCalls.at(-1)!.includes('PAGE 1') &&
      !llm.textCalls.at(-1)!.includes('PAGE 3'),
    `${llm.textCalls.at(-1)?.length ?? 0} chars`);
  check('the whole file is still what gets stored',
    (await pagesIn(storage.uploads.at(-1)!.data as Uint8Array)) === 3,
    `${await pagesIn(storage.uploads.at(-1)!.data as Uint8Array)} page(s)`);

  /*
   * The reason this check exists is a production failure that a passing local run hid.
   *
   * pdfjs polyfills `DOMMatrix` from `@napi-rs/canvas`, an optional dependency, and then
   * evaluates `new DOMMatrix()` at module scope — so it loads on a laptop that happens to
   * have the native binary and throws `DOMMatrix is not defined` on a server that does not.
   * `installPdfDomStubs` puts our own stubs in first *on every platform*, which is what makes
   * this run and production the same run. If that ever stops happening, everything above
   * still passes here and every PDF import still fails there; this is the line that notices.
   */
  const inPlay = (globalThis as unknown as Record<string, { name?: string } | undefined>).DOMMatrix;
  check('the PDF reader ran on the same globals production has, not the laptop\'s native ones',
    inPlay?.name === 'TextOnlyDOMMatrix', inPlay?.name ?? 'none installed');

  const uploadsBefore = storage.uploads.length;
  const callsBefore = llm.textCalls.length + llm.documentCalls.length;
  const again = await importDocument(ctx, {
    data: threePageText, mimeType: 'application/pdf', fileName: 'lab-copy.pdf',
  });

  check('importing the same bytes again is skipped, not filed twice', again.status === 'skipped',
    again.status);
  check('and costs no model call',
    llm.textCalls.length + llm.documentCalls.length === callsBefore,
    `${llm.textCalls.length + llm.documentCalls.length - callsBefore} extra call(s)`);
  check('and stores nothing', storage.uploads.length === uploadsBefore);

  const scanned = await importDocument(ctx, {
    data: await scannedPdf(2), mimeType: 'application/pdf', fileName: 'scan.pdf',
  });
  check('a PDF with no text layer takes the vision route',
    scanned.status === 'imported' && scanned.route === 'vision',
    scanned.status === 'imported' ? scanned.route : scanned.status);
  check('and only its first page is sent',
    (await pagesIn(llm.lastDocumentCall[0].data)) === 1,
    `${await pagesIn(llm.lastDocumentCall[0].data)} page(s)`);

  const refused = await importDocument(ctx, {
    data: new Uint8Array([1, 2, 3]), mimeType: 'text/html', fileName: 'note.html',
  });
  check('an unsupported type is refused rather than filed',
    refused.status === 'refused' && refused.reason === 'unsupported_type',
    refused.status === 'refused' ? refused.reason : refused.status);

  const empty = await importDocument(ctx, {
    data: new Uint8Array(), mimeType: 'application/pdf', fileName: 'empty.pdf',
  });
  check('an empty file is refused', empty.status === 'refused' && empty.reason === 'empty');

  // Drive answers `application/octet-stream` for plenty of ordinary PDFs; refusing those
  // would make a perfectly good folder look unimportable.
  const byName = await importDocument(ctx, {
    data: await textPdf(1, 'OCTET'), mimeType: 'application/octet-stream', fileName: 'referral.pdf',
  });
  check('a PDF the provider would not name is recognised by its file name',
    byName.status === 'imported', byName.status);

  /* --- importing from a folder ---------------------------------------------------- */

  const folders = await listImportFolders(ctx, null);
  check('the admin can list folders', folders.length === 1 && folders[0].name === 'מסמכים רפואיים');

  const listing = await listImportFiles(ctx, 'folder-1');
  check('every file in the folder is listed, importable or not', listing.length === 2,
    `${listing.length}`);
  check('and the ones this app cannot take are marked, not hidden',
    listing.filter((file) => file.importable).length === 1,
    listing.map((file) => `${file.name}:${file.importable}`).join(' '));

  const fromFolder = await importFromSource(ctx, { fileId: 'file-1', fileName: 'lab.pdf' });
  check('a file already imported from disk is skipped when the folder is imported too',
    fromFolder.status === 'skipped', fromFolder.status);

  /* --- who may do what ------------------------------------------------------------ */

  const editor: SpaceContext = { spaceId, userId: other.id, role: 'editor', requestId: randomUUID() };
  const refusedScope = await setScanScope(editor, false).then(() => null).catch((err: Error) => err.name);
  check('an editor cannot change how documents are read', refusedScope === 'ForbiddenError',
    refusedScope ?? 'it succeeded');
  check('and the setting is unchanged', (await getSpaceSettings(ctx)).firstPageOnly === true);

  const coOwner: SpaceContext = { spaceId, userId: other.id, role: 'owner', requestId: randomUUID() };
  const refusedBrowse = await listImportFolders(coOwner, null)
    .then(() => null)
    .catch((err: Error & { reason?: string }) => err.reason ?? err.name);
  check('an owner who is not the admin cannot browse the admin\'s Drive',
    refusedBrowse === 'not_the_admin', refusedBrowse ?? 'it succeeded');

  /* --- the setting belongs to one space ------------------------------------------- */

  const { spaceId: otherSpaceId } = await createSpaceWithAdmin({
    name: 'scope-2', subjectName: 'אבא', adminUserId: other.id,
  });
  const otherCtx: SpaceContext = {
    spaceId: otherSpaceId, userId: other.id, role: 'owner', requestId: randomUUID(),
  };
  await setScanScope(otherCtx, false);

  check('one space turning it off leaves the other alone',
    (await getSpaceSettings(ctx)).firstPageOnly === true &&
      (await getSpaceSettings(otherCtx)).firstPageOnly === false);
  check('and the document imported into the first space is not visible from the second',
    (await readInSpace(otherCtx, (repos) => repos.documents.list({ limit: 50 }))).length === 0);

  console.log(`\n${failures === 0 ? 'All scan-scope checks passed.' : `${failures} check(s) FAILED.`}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    // pdfjs closes its worker handles asynchronously; exiting into that aborts the process.
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.exit(failures === 0 ? 0 : 1);
  });

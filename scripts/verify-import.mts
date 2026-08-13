import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import type { AnyContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import type {
  ExtractionRequest,
  LlmPort,
  LlmResult,
  TextExtractionRequest,
} from '@/core/ports/llm';
import { listDocuments, searchDocuments } from '@/modules/documents';
import { importFolder } from './import-documents.mjs';

/**
 * The bulk import, against a real database and fake ports.
 *
 * The property worth automating is the one that costs the most to get wrong: **a second run
 * must not file everything twice.** Nothing in `modules/documents` dedups — no hash column,
 * no check — so the only thing standing between a re-run and 332 documents is the ledger this
 * script keeps. That is exactly the kind of guarantee that looks obviously fine and is not.
 *
 * The rest of what it pins down: that a PDF carrying its own text is routed away from the
 * vision model (the entire cost argument for this design), that a resumed run picks up where
 * it stopped, that an unsupported file is reported rather than silently dropped, and that the
 * stored text is searchable afterwards.
 *
 * The model and Drive are both fakes. What is real is the routing, the ledger, the database
 * and the module — which is where the mistakes would be.
 *
 * Run with: npm run verify:import
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

class FakeStorage implements FileStoragePort {
  uploads = 0;
  private files = new Map<string, FileBlob>();

  async upload(_ctx: unknown, file: FileBlob): Promise<StoredFile> {
    this.uploads++;
    const ref = `ref-${this.uploads}`;
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

/**
 * Counts how it was asked, which is the whole point: `fromText` going up and `fromDocument`
 * staying at zero is what "the text layer keeps documents away from the vision model" means
 * in a number.
 */
class CountingLlm implements LlmPort {
  fromDocument = 0;
  fromText = 0;

  async extractFromDocument<T>(_ctx: AnyContext, request: ExtractionRequest): Promise<LlmResult<T>> {
    this.fromDocument++;
    return this.reply(`נסרק ${request.files.length} עמוד`, 'סרוק') as LlmResult<T>;
  }

  async extractFromText<T>(_ctx: AnyContext, request: TextExtractionRequest): Promise<LlmResult<T>> {
    this.fromText++;
    return this.reply(request.text, 'טקסט') as LlmResult<T>;
  }

  async complete(): Promise<LlmResult<string>> {
    return { value: '', usage: { model: 'fake', tokensIn: 0, tokensOut: 0 } };
  }

  private reply(fullText: string, marker: string) {
    return {
      value: {
        name: `מסמך ${marker}`,
        docType: 'תוצאות מעבדה',
        docDate: '2026-05-04',
        hospital: 'כללית',
        doctor: 'ד"ר לוי',
        tags: ['ייבוא'],
        actionRequired: false,
        actionSummary: null,
        fullText,
      },
      usage: { model: 'fake', tokensIn: 0, tokensOut: 0 },
    };
  }
}

/** A PDF that genuinely carries a text layer, so the routing decision is made on real bytes. */
async function textPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  // Several lines, because the adapter requires a page to clear MIN_CHARS_PER_PAGE before it
  // counts as carrying text.
  for (let i = 0; i < 12; i++) {
    page.drawText(`${text} line ${i} with enough characters to count as a real page`, {
      x: 40, y: 750 - i * 24, size: 11, font,
    });
  }
  return pdf.save();
}

/** A PDF with no text at all — a stand-in for a scan, which must reach the vision path. */
async function imagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.drawRectangle({ x: 50, y: 50, width: 500, height: 700 });
  return pdf.save();
}

async function main() {
  const storage = new FakeStorage();
  const llm = new CountingLlm();
  __setPorts({ fileStorage: storage, llm });

  const stamp = randomUUID().slice(0, 8);
  const [owner] = await db
    .insert(users)
    .values({ email: `import-${stamp}@example.test`, name: 'מייבא' })
    .returning();
  const { spaceId } = await createSpaceWithAdmin({
    name: 'import', subjectName: 'אמא', adminUserId: owner.id,
  });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const dir = await mkdtemp(path.join(tmpdir(), 'healthapp-import-'));
  const ledger = path.join(dir, 'ledger.json');

  await writeFile(path.join(dir, 'a-with-text.pdf'), await textPdf('BLOOD COUNT REPORT'));
  await writeFile(path.join(dir, 'b-with-text.pdf'), await textPdf('DISCHARGE SUMMARY'));
  await writeFile(path.join(dir, 'c-scanned.pdf'), await imagePdf());
  await writeFile(path.join(dir, 'd-notes.docx'), 'not a document this app stores');

  const args = { dir, space: spaceId, dryRun: false, limit: Number.POSITIVE_INFINITY, ledger };

  /* --- first run --------------------------------------------------------------- */

  const first = await importFolder(args);

  const imported = first.filter((o) => o.status === 'imported');
  check('every supported file is imported', imported.length === 3, `${imported.length} of 3`);
  check('the unsupported one is reported, not dropped',
    first.some((o) => o.file.endsWith('.docx') && o.status === 'failed'),
    first.find((o) => o.file.endsWith('.docx'))?.detail ?? 'missing');

  // The cost argument for the whole design, as a number.
  check('a PDF carrying its own text never reaches the vision model',
    llm.fromText === 2 && llm.fromDocument === 1, `text=${llm.fromText} vision=${llm.fromDocument}`);
  check('and is recorded as having taken that route',
    imported.filter((o) => o.route === 'text-layer').length === 2,
    imported.map((o) => o.route).join(', '));

  const afterFirst = await listDocuments(ctx);
  check('the documents exist in the space', afterFirst.length === 3, `${afterFirst.length}`);
  check('one blob stored per document', storage.uploads === 3, `${storage.uploads}`);

  // The text that came off the page is what got indexed, not a description of it.
  const hits = await searchDocuments(ctx, { text: 'DISCHARGE' });
  check('the extracted text is searchable', hits.length === 1, `${hits.length} hit(s)`);

  /* --- the run that must not duplicate ----------------------------------------- */

  const beforeSecond = { text: llm.fromText, vision: llm.fromDocument, uploads: storage.uploads };
  const second = await importFolder(args);

  check('a second run imports nothing',
    second.filter((o) => o.status === 'imported').length === 0);
  check('and skips every file it already did',
    second.filter((o) => o.status === 'skipped').length === 3,
    `${second.filter((o) => o.status === 'skipped').length}`);

  const afterSecond = await listDocuments(ctx);
  check('the space still holds three documents, not six',
    afterSecond.length === 3, `${afterSecond.length}`);
  check('no model call was spent on the re-run',
    llm.fromText === beforeSecond.text && llm.fromDocument === beforeSecond.vision,
    `text=${llm.fromText} vision=${llm.fromDocument}`);
  check('and nothing was uploaded again', storage.uploads === beforeSecond.uploads);

  /* --- resuming a run that stopped partway -------------------------------------- */

  const resumeDir = await mkdtemp(path.join(tmpdir(), 'healthapp-resume-'));
  const resumeLedger = path.join(resumeDir, 'ledger.json');
  await writeFile(path.join(resumeDir, 'one.pdf'), await textPdf('FIRST'));
  await writeFile(path.join(resumeDir, 'two.pdf'), await textPdf('SECOND'));
  await writeFile(path.join(resumeDir, 'three.pdf'), await textPdf('THIRD'));

  const resumeArgs = { dir: resumeDir, space: spaceId, dryRun: false, ledger: resumeLedger };
  const stopped = await importFolder({ ...resumeArgs, limit: 1 });
  check('a limited run stops where it was told',
    stopped.filter((o) => o.status === 'imported').length === 1);

  const resumed = await importFolder({ ...resumeArgs, limit: Number.POSITIVE_INFINITY });
  check('resuming imports only what is left',
    resumed.filter((o) => o.status === 'imported').length === 2,
    `${resumed.filter((o) => o.status === 'imported').length}`);
  check('and skips the one already done',
    resumed.filter((o) => o.status === 'skipped').length === 1);

  const ledgerContents = JSON.parse(await readFile(resumeLedger, 'utf8')) as Record<string, unknown>;
  check('the ledger holds one entry per file', Object.keys(ledgerContents).length === 3,
    `${Object.keys(ledgerContents).length}`);

  // The ledger and the report land beside the documents, so a re-run reads them back. Left
  // unhandled they are reported as unsupported documents and the run exits non-zero — a
  // failure invented entirely by the script, indistinguishable from a real one.
  check('the script does not treat its own ledger and report as documents',
    !resumed.some((o) => o.file.endsWith('.json')),
    resumed.filter((o) => o.file.endsWith('.json')).map((o) => o.file).join(', ') || 'none seen');

  /* --- a dry run writes nothing -------------------------------------------------- */

  const dryDir = await mkdtemp(path.join(tmpdir(), 'healthapp-dry-'));
  await writeFile(path.join(dryDir, 'x.pdf'), await textPdf('DRY'));
  const uploadsBeforeDry = storage.uploads;
  const documentsBeforeDry = (await readInSpace(ctx, (repos) => repos.documents.list({ limit: 200 }))).length;

  await importFolder({
    dir: dryDir, space: spaceId, dryRun: true,
    limit: Number.POSITIVE_INFINITY, ledger: path.join(dryDir, 'ledger.json'),
  });

  check('a dry run stores no blob', storage.uploads === uploadsBeforeDry);
  check('and creates no document',
    (await readInSpace(ctx, (repos) => repos.documents.list({ limit: 200 }))).length === documentsBeforeDry);

  await rm(dir, { recursive: true, force: true });
  await rm(resumeDir, { recursive: true, force: true });
  await rm(dryDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'All import checks passed.' : `${failures} check(s) FAILED.`}`);
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

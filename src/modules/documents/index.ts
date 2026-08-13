import { assertCan, can } from '@/core/context/authorization';
import { isSystemContext, type AnyContext } from '@/core/context/space-context';
import {
  getFileStorage,
  getImportSource,
  getLlm,
  getPdfText,
  getProviderConnection,
} from '@/core/container';
import type { DocumentSort } from '@/core/db/repositories';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { event } from '@/core/events/types';
import { errorFields, log } from '@/core/logging/logger';
import type { ImportFolder } from '@/core/ports/file-import';
import { isSupportedScanType, PDF_TYPE, type ScanFile } from '@/core/ports/llm';
import { hasUsableTextLayer } from '@/core/ports/pdf-text';
import { combinePages, storedFileName, type CombinedFile } from './internal/combine-pages';
import { firstPageOf, pageCountOf } from './internal/first-page';
import {
  extensionFor,
  isStorableDocumentType,
  normalizeMediaType,
  servableTypeFor,
  typeForFileName,
} from './internal/media-types';

export { UncombinablePageError } from './internal/combine-pages';
export type { CombinedFile } from './internal/combine-pages';
/**
 * Exposed because the scan and confirm actions have to refuse an unstorable type before
 * they build a `CombinedFile` around it. The check inside `saveDocument` is the one that
 * enforces it; these let the edge say so in Hebrew first.
 */
export { extensionFor, isStorableDocumentType, STORABLE_DOCUMENT_TYPES } from './internal/media-types';
/**
 * How the file list can be ordered, and how many tags one query will filter by. Re-exported
 * so the screen asks the module rather than reaching into the repositories for the vocabulary
 * of a query it is not allowed to write itself.
 */
export { MAX_TAG_FILTERS } from '@/core/db/repositories';
export type { DocumentSort } from '@/core/db/repositories';

/**
 * M1 — documents. Scan or upload, extract, confirm, store (DESIGN.md §5).
 *
 * Extraction and saving are deliberately two steps. The model's output is a
 * *suggestion*: the user sees it, corrects it, and only then does a document exist.
 * Nothing here writes a document the user has not looked at.
 */

export interface ExtractedFields {
  name: string;
  docType: string | null;
  docDate: string | null;
  hospital: string | null;
  doctor: string | null;
  tags: string[];
  actionRequired: boolean;
  actionSummary: string | null;
  fullText: string;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'שם קצר ותיאורי למסמך, בעברית' },
    docType: {
      type: ['string', 'null'],
      description: 'סוג המסמך, למשל: סיכום ביקור, תוצאות מעבדה, הפניה, מרשם, פענוח הדמיה',
    },
    docDate: { type: ['string', 'null'], description: 'תאריך המסמך בפורמט YYYY-MM-DD' },
    hospital: { type: ['string', 'null'], description: 'בית החולים, המרפאה או קופת החולים' },
    doctor: { type: ['string', 'null'], description: 'שם הרופא/ה' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'תגיות קצרות לחיפוש: תחום רפואי, איבר, סוג בדיקה',
    },
    actionRequired: {
      type: 'boolean',
      description: 'האם המסמך דורש פעולה — לקבוע תור, לקחת תרופה, לבצע בדיקה נוספת',
    },
    actionSummary: { type: ['string', 'null'], description: 'הפעולה הנדרשת, במשפט אחד' },
    fullText: { type: 'string', description: 'כל הטקסט במסמך, כפי שהוא' },
  },
  required: ['name', 'docType', 'docDate', 'hospital', 'doctor', 'tags', 'actionRequired', 'actionSummary', 'fullText'],
  additionalProperties: false,
} as const;

const INSTRUCTIONS = [
  'זהו מסמך רפואי, לרוב בעברית. חלץ את השדות המבוקשים.',
  'העתק את הטקסט המלא במדויק — הוא משמש לחיפוש מאוחר יותר.',
  'אם שדה אינו מופיע במסמך, החזר null. אל תנחש ואל תמציא.',
  'התאריך המבוקש הוא תאריך המסמך עצמו, לא תאריך ההדפסה.',
].join(' ');

/**
 * Added only when more than one page arrives. Without it the model tends to describe the
 * pages separately; the point is that they are one document.
 */
const MULTI_PAGE_INSTRUCTION = [
  'המסמך מורכב מכמה עמודים המצורפים לפי הסדר.',
  'יש להתייחס אליהם כמסמך אחד ולחלץ שדות מכל העמודים יחד.',
  'הטקסט המלא צריך לכלול את כל העמודים, לפי סדרם.',
].join(' ');

/**
 * For `extractFromText`, where the text arrived from the PDF itself rather than from reading
 * a picture. The model is looking at a transcript, so the instruction to *copy* the full text
 * becomes an instruction to return it unchanged — otherwise it summarises, and the search
 * index quietly becomes a summary of the record instead of the record.
 */
const FROM_TEXT_INSTRUCTION = [
  'הטקסט המצורף חולץ מהמסמך עצמו ומדויק.',
  'יש להחזיר אותו ב-fullText כפי שהוא, במלואו, בלי לקצר ובלי לסכם.',
].join(' ');

/**
 * Added when the space reads first pages only and the document has more than one.
 *
 * Without it the model is looking at page one of nine with no way to know that, and fills
 * `fullText` as though it had the document — which is exactly the situation where it starts
 * inferring what the rest probably said. Told plainly that the rest exists and was not
 * provided, it reports what is in front of it and stops there.
 */
const FIRST_PAGE_INSTRUCTION = [
  'מצורף העמוד הראשון בלבד של מסמך ארוך יותר; שאר העמודים לא צורפו.',
  'יש לחלץ רק מה שמופיע בעמוד הזה, ולהחזיר ב-fullText את הטקסט של העמוד הזה בלבד.',
  'אין להשלים או לנחש מה כתוב בעמודים שלא צורפו.',
].join(' ');

/**
 * Step one: read the document — a photo, a scan, a PDF, or several pages of them. Writes
 * nothing; the caller shows the result to the user for confirmation. Costs an LLM call,
 * so it is never on a read path.
 *
 * Every page goes into the same call. A two-page letter has its date on the first page and
 * its instructions on the second, and extracting them separately would produce two half
 * documents instead of one whole one.
 */
export interface ScanReading {
  fields: ExtractedFields;
  /**
   * The pages combined into the single file that will be stored if the user confirms.
   *
   * Combining happens here, not at save time, so only one artifact travels to the browser
   * and back for the confirmation step instead of every page twice. The model still reads
   * the *originals* above — a photograph is sharper than the same photograph after a trip
   * through a PDF, and OCR quality is the whole game (DESIGN.md §12).
   */
  combined: CombinedFile;
  /** How many pages the document has in total, however many files carried them. */
  pageCount: number;
  /**
   * How many of them were actually read. Lower than `pageCount` when the space reads first
   * pages only — the confirmation screen says so, because a person looking at fields drawn
   * from one page of five should be told that is what they are looking at.
   */
  pagesRead: number;
}

/**
 * What a space has decided about how it handles documents. Both defaults are the cautious
 * answer — see the column notes in `schema.ts` for why each one is.
 */
export interface SpaceSettings {
  /** Read page one only, rather than the whole document. */
  firstPageOnly: boolean;
  /** Offer importing from a folder in the admin's existing Drive, which needs a wider grant. */
  driveImportEnabled: boolean;
}

/**
 * The defaults a space gets before anybody visits the settings screen, and the answers when
 * a space row somehow cannot be read. Stated once, here, so the column defaults and the code
 * defaults cannot drift apart.
 */
export const DEFAULT_FIRST_PAGE_ONLY = true;
export const DEFAULT_DRIVE_IMPORT_ENABLED = false;

export async function getSpaceSettings(ctx: AnyContext): Promise<SpaceSettings> {
  assertCan(ctx, 'space.read');
  const space = await readInSpace(ctx, (repos) => repos.space.get());
  return {
    firstPageOnly: space?.ocrFirstPageOnly ?? DEFAULT_FIRST_PAGE_ONLY,
    driveImportEnabled: space?.driveImportEnabled ?? DEFAULT_DRIVE_IMPORT_ENABLED,
  };
}

export async function setScanScope(ctx: AnyContext, firstPageOnly: boolean): Promise<SpaceSettings> {
  assertCan(ctx, 'space.configure');

  const row = await withSpace(ctx, async (uow) => {
    const updated = await uow.repos.space.setSettings({ ocrFirstPageOnly: firstPageOnly });
    // In the activity log because it changes what every future document in this space will
    // contain, and a member wondering why last month's letters are searchable and this
    // month's are not deserves to find the answer there (DESIGN.md §7.2).
    uow.emit(
      event(
        'space.scan_scope_changed',
        'space',
        ctx.spaceId,
        firstPageOnly ? 'קריאת מסמכים: עמוד ראשון בלבד' : 'קריאת מסמכים: כל העמודים',
      ),
    );
    return updated;
  });

  return {
    firstPageOnly: row?.ocrFirstPageOnly ?? firstPageOnly,
    driveImportEnabled: row?.driveImportEnabled ?? DEFAULT_DRIVE_IMPORT_ENABLED,
  };
}

/**
 * Turning the Drive import option on, or off again.
 *
 * The reason this is a setting at all, rather than a screen that is simply there: it is the
 * one feature in the app that needs Google access beyond "files this app created", and
 * something with that consequence should be a switch somebody threw after reading what it
 * means — including how to take the permission back, which the settings screen states.
 *
 * Turning it **off** is honest about its own limits and so is this comment. It stops the app
 * asking for the scope and stops it using one already granted, immediately, for everybody in
 * the space. It cannot un-grant anything: the permission lives on the admin's Google account
 * and only Google can hand it back, which is why `revocation` is spelled out on screen rather
 * than implied by a toggle going grey.
 */
export async function setDriveImport(ctx: AnyContext, enabled: boolean): Promise<SpaceSettings> {
  assertCan(ctx, 'space.configure');

  const row = await withSpace(ctx, async (uow) => {
    const updated = await uow.repos.space.setSettings({ driveImportEnabled: enabled });
    // In the activity log because it widens what the app may reach in somebody's Google
    // account, and every member should be able to see when that happened (DESIGN.md §7.2).
    uow.emit(
      event(
        'space.drive_import_changed',
        'space',
        ctx.spaceId,
        enabled ? 'הופעל ייבוא מתיקייה ב-Drive' : 'בוטל ייבוא מתיקייה ב-Drive',
      ),
    );
    return updated;
  });

  return {
    firstPageOnly: row?.ocrFirstPageOnly ?? DEFAULT_FIRST_PAGE_ONLY,
    driveImportEnabled: row?.driveImportEnabled ?? enabled,
  };
}

/**
 * The scope this read runs under: what the caller insisted on, or what the space decided.
 *
 * The override exists for the command-line import (`--all-pages`) and for the verification
 * scripts, which have to be able to exercise both branches against one space. Everything the
 * app itself does passes nothing and gets the space's own answer, which is the point — the
 * setting would be worth very little if each screen had to remember to consult it.
 *
 * No permission check: every caller has already asserted the one that lets it read a
 * document at all, and this is a detail of how that read is performed.
 */
async function readingScope(ctx: AnyContext, override?: boolean): Promise<boolean> {
  if (override !== undefined) return override;
  const space = await readInSpace(ctx, (repos) => repos.space.get());
  return space?.ocrFirstPageOnly ?? DEFAULT_FIRST_PAGE_ONLY;
}

export async function extractFromScan(
  ctx: AnyContext,
  files: readonly ScanFile[],
  opts: { firstPageOnly?: boolean } = {},
): Promise<ScanReading> {
  assertCan(ctx, 'document.create');
  if (files.length === 0) throw new DocumentError('empty_scan');

  const firstPageOnly = await readingScope(ctx, opts.firstPageOnly);
  const pageCount = await pageCountOf(files);

  /*
   * Only the first *file* survives, and only its first page. Both halves matter: someone who
   * photographed a letter as three images has three files and one document, and sending
   * files two and three while calling it a first-page read would be neither one thing nor
   * the other.
   */
  const read = firstPageOnly ? [await firstPageOf(files[0])] : files;
  const pagesRead = firstPageOnly ? Math.min(1, pageCount) : pageCount;

  const instructions =
    firstPageOnly && pageCount > 1
      ? `${INSTRUCTIONS} ${FIRST_PAGE_INSTRUCTION}`
      : read.length > 1
        ? `${INSTRUCTIONS} ${MULTI_PAGE_INSTRUCTION}`
        : INSTRUCTIONS;

  const result = await getLlm().extractFromDocument<ExtractedFields>(ctx, {
    files: read,
    schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    instructions,
  });

  return {
    fields: result.value,
    // Every page the user submitted, not only the ones that were read: what gets stored is
    // the whole document either way.
    combined: await combinePages(files),
    pageCount,
    pagesRead,
  };
}

/**
 * Reading a document whose text is already in hand.
 *
 * Same schema, same fields, same confirmation step — the only difference is that the pages
 * never go to a vision model, because for a PDF that carries its own text layer there is
 * nothing for one to look at that the file did not already say. Measured on the first bulk
 * import: 135 of 149 documents were in that state.
 *
 * `fullText` comes back from the model rather than being substituted here on purpose. The
 * model is told to echo it unchanged, and if it ever does not, the document that gets stored
 * is the one the model actually read — silently substituting our copy would hide the
 * disagreement rather than surface it.
 */
export async function extractFromText(ctx: AnyContext, text: string): Promise<ExtractedFields> {
  assertCan(ctx, 'document.create');

  const result = await getLlm().extractFromText<ExtractedFields>(ctx, {
    text,
    schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    instructions: `${INSTRUCTIONS} ${FROM_TEXT_INSTRUCTION}`,
  });

  return result.value;
}

/**
 * Step two: the user has confirmed (and possibly corrected) the fields.
 *
 * Order matters. The blob goes to storage first, because a failed upload should leave
 * no database row; the row then commits together with its activity entry inside one
 * transaction, so an audited document and an unaudited one cannot diverge.
 */
export async function saveDocument(
  ctx: AnyContext,
  input: {
    fields: ExtractedFields;
    /**
     * The already-combined file from `extractFromScan` — one blob, however many pages the
     * user photographed. The document owns exactly one ref, so `storageRef` stays the
     * single opaque string the rest of the app relies on (DESIGN.md §4).
     */
    file: CombinedFile;
    /** How many pages went into it. Recorded for the log, not the row. */
    pageCount?: number;
    /** What the model originally proposed, retained beside the confirmed values. */
    proposed?: Record<string, unknown>;
    /**
     * SHA-256 of the stored bytes, set by the import and by nothing else — it is what makes
     * re-running an import skip rather than re-file. The scan form leaves it null: a
     * photograph of a page is never byte-identical to another photograph of it, so a hash
     * there would cost a column and catch nothing.
     */
    contentHash?: string;
  },
) {
  assertCan(ctx, 'document.create');

  const combined = input.file;

  /*
   * The type is checked here, in the module, and not only at the edge that produced it.
   *
   * `scanDocument` screens what it accepts, but `confirmDocument` is a server action — a
   * public POST endpoint whose arguments arrive as whatever the caller sent, whatever the
   * signature says. Those bytes and that type go on to be served back to every member from
   * this app's own origin, so a caller choosing `text/html` here would be choosing to run
   * script in their sessions. The one guard that cannot be walked around is the one on the
   * write path itself.
   */
  if (!isStorableDocumentType(combined.mimeType)) {
    throw new DocumentError('unsupported_type');
  }

  const year = input.fields.docDate?.slice(0, 4) ?? String(new Date().getFullYear());
  const stored = await getFileStorage().upload(
    ctx,
    { data: combined.data, mimeType: combined.mimeType },
    {
      folder: `HealthApp/${year}`,
      name: storedFileName(input.fields.name, combined.extension),
    },
  );

  const document = await withSpace(ctx, async (uow) => {
    const row = await uow.repos.documents.create({
      name: input.fields.name,
      docType: input.fields.docType,
      docDate: input.fields.docDate,
      hospital: input.fields.hospital,
      doctor: input.fields.doctor,
      storageRef: stored.ref,
      storageProvider: stored.provider,
      mimeType: combined.mimeType,
      extractedText: input.fields.fullText,
      actionRequired: input.fields.actionRequired,
      extractionRaw: input.proposed ?? null,
      contentHash: input.contentHash ?? null,
    });

    await uow.repos.tags.attach(row.id, input.fields.tags);

    uow.emit(event('document.created', 'document', row.id, `נוסף מסמך: ${row.name}`));

    // A separate event, not a flag on the first: the calendar module reacts to this one
    // to propose a reminder, and it must not have to inspect document payloads to
    // decide (DESIGN.md §5, M2).
    if (input.fields.actionRequired && input.fields.actionSummary) {
      uow.emit(
        event('document.action_required', 'document', row.id, `נדרשת פעולה: ${input.fields.actionSummary}`, {
          action: input.fields.actionSummary,
        }),
      );
    }

    return row;
  });

  log.info('document.created', {
    module: 'documents',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    documentId: document.id,
    count: input.pageCount,
    outcome: 'success',
  });

  return document;
}

/* ------------------------------------------------------------------- bulk import */

/**
 * Filing a folder of documents that already exist, one file at a time.
 *
 * The scan form is built around a person photographing a page: several files are *one*
 * document, extraction is a proposal, and nothing is written until they have looked at it.
 * A folder of two hundred documents is the opposite of all three — every file is its own
 * document, nobody is going to review two hundred proposals, and the pages already exist.
 * So this is a different entry point rather than a loop around the old one, and it commits
 * without confirmation. That is the trade the import screen states plainly: the fields are
 * a model's guess and every one of them is correctable afterwards on the file screen.
 *
 * The caller drives the loop and this handles exactly one file, which is what makes the
 * import interruptible, resumable, and honest about progress. It also keeps every request
 * bounded: two hundred documents in one call would be one request that cannot fit in any
 * platform's execution limit.
 */

/**
 * What one imported file may weigh.
 *
 * Not the scan form's ~2.8 MB, which is a *server action body* limit and does not apply
 * here: local files POST to a route handler and Drive files never travel through the
 * browser at all. This bound is about the model instead — Anthropic accepts 32 MB per
 * request, and a document this size is a scan at a resolution nobody needed.
 */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** How the fields were obtained, which is the difference between pennies and pounds. */
export type ExtractionRoute = 'text-layer' | 'vision';

export interface ImportCandidate {
  data: Uint8Array;
  /** What the provider says it is. Falls back to the file name when it declines to say. */
  mimeType: string;
  /** For reporting only — the stored name comes from what the extraction produced. */
  fileName: string;
}

export type ImportOutcome =
  | {
      status: 'imported';
      documentId: string | null;
      route: ExtractionRoute;
      name: string;
      docDate: string | null;
      pagesRead: number;
      pageCount: number;
    }
  | { status: 'skipped'; documentId: string; name: string }
  | { status: 'refused'; reason: 'unsupported_type' | 'too_large' | 'empty' };

/**
 * Bytes → hex, through the platform's own SHA-256.
 *
 * `crypto.subtle` rather than `node:crypto` so the module stays runtime-agnostic; it is
 * the same digest, and the file is already in memory.
 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read one file and file it, or say why not.
 *
 * Three things happen in order, and the order is the whole design:
 *
 * 1. **Screen it.** Type and size are checked before anything is read, because every step
 *    after this one costs either a model call or a Drive round trip.
 * 2. **Have we already got it?** Identical bytes, already in this space, means the import
 *    has been run over this folder before. Skipping is worth more than it sounds: without
 *    it a second run files everything twice *and* pays a model call for each — see the
 *    `content_hash` note in `schema.ts` for what this does and does not claim to catch.
 * 3. **Route it.** A PDF that carries its own text is read off the page and never shown to
 *    a vision model. Measured on the first real import: 135 of 149 documents were in that
 *    state, and paying a model to look at a picture of text the file is handing over is the
 *    single most avoidable cost in this app.
 *
 * `firstPageOnly` applies to both routes — one page to the vision model, or one page of
 * text to the text model. The space's own setting is used unless the caller overrides it.
 */
export async function importDocument(
  ctx: AnyContext,
  candidate: ImportCandidate,
  opts: { firstPageOnly?: boolean; dryRun?: boolean } = {},
): Promise<ImportOutcome> {
  assertCan(ctx, 'document.create');

  // The provider is the authority; the file name is the fallback for when it shrugs and
  // says `application/octet-stream`, which Drive does for plenty of ordinary PDFs.
  const declared = normalizeMediaType(candidate.mimeType);
  const mimeType = isStorableDocumentType(declared)
    ? declared
    : (typeForFileName(candidate.fileName) ?? declared);

  if (!isStorableDocumentType(mimeType) || !isSupportedScanType(mimeType)) {
    return { status: 'refused', reason: 'unsupported_type' };
  }
  if (candidate.data.length === 0) return { status: 'refused', reason: 'empty' };
  if (candidate.data.length > MAX_IMPORT_BYTES) return { status: 'refused', reason: 'too_large' };

  const contentHash = await sha256Hex(candidate.data);
  const existing = await readInSpace(ctx, (repos) => repos.documents.findByContentHash(contentHash));
  if (existing) return { status: 'skipped', documentId: existing.id, name: existing.name };

  const firstPageOnly = await readingScope(ctx, opts.firstPageOnly);
  const file: ScanFile = { data: candidate.data, mimeType };

  let fields: ExtractedFields;
  let route: ExtractionRoute;
  let pageCount = 1;
  let pagesRead = 1;

  /*
   * A text layer that cannot be read is a missed saving, never a failed import.
   *
   * The cheap route depends on a PDF library loading and parsing somebody else's file, and
   * both halves can fail for reasons that have nothing to do with whether this document can
   * be imported — a malformed PDF, or the library itself refusing to load in a particular
   * runtime, which is precisely what happened on the first deploy of this feature. Letting
   * that throw would mean an app that imports nothing at all, when what it actually lost was
   * a discount.
   *
   * It is logged as a warning rather than swallowed, because the failure is otherwise
   * invisible in exactly the way that costs money: every import silently takes the vision
   * route and the only symptom is the bill on the שימוש AI screen.
   */
  let layer = null;
  if (mimeType === PDF_TYPE) {
    try {
      layer = await getPdfText().readTextLayer(candidate.data);
    } catch (err) {
      log.warn('document.text_layer.unreadable', {
        module: 'documents',
        spaceId: ctx.spaceId,
        requestId: ctx.requestId,
        outcome: 'degraded',
        ...errorFields(err),
      });
    }
  }

  if (layer && hasUsableTextLayer(layer)) {
    pageCount = layer.pageCount;
    // A first page that happens to carry no text is not a reason to give up on the text
    // route's premise — but it is a reason not to send an empty string to a model. The
    // `text` below is empty in that case and the `else` branch picks it up.
    const text = firstPageOnly ? (layer.pages[0] ?? '') : layer.text;
    if (text.trim()) {
      fields = await extractFromText(ctx, text);
      route = 'text-layer';
      pagesRead = firstPageOnly ? 1 : layer.pagesWithText;
    } else {
      const reading = await extractFromScan(ctx, [file], { firstPageOnly });
      fields = reading.fields;
      route = 'vision';
      pageCount = reading.pageCount;
      pagesRead = reading.pagesRead;
    }
  } else {
    const reading = await extractFromScan(ctx, [file], { firstPageOnly });
    fields = reading.fields;
    route = 'vision';
    pageCount = reading.pageCount;
    pagesRead = reading.pagesRead;
  }

  if (opts.dryRun) {
    return {
      status: 'imported',
      documentId: null,
      route,
      name: fields.name,
      docDate: fields.docDate,
      pagesRead,
      pageCount,
    };
  }

  const document = await saveDocument(ctx, {
    fields,
    // One file in, one file stored, whole. `combinePages` is for a letter photographed page
    // by page; here the file already *is* the document, every page of it, whether or not
    // every page was read.
    file: { data: candidate.data, mimeType, extension: extensionFor(mimeType) },
    pageCount,
    proposed: fields as unknown as Record<string, unknown>,
    contentHash,
  });

  log.info('document.imported', {
    module: 'documents',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    documentId: document.id,
    operation: route,
    count: pagesRead,
    outcome: 'success',
  });

  return {
    status: 'imported',
    documentId: document.id,
    route,
    name: fields.name,
    docDate: fields.docDate,
    pagesRead,
    pageCount,
  };
}

/* ------------------------------------------- importing from the space's own Drive */

/**
 * Who may point this app at an existing folder in the space's Google account.
 *
 * `document.import` is owner-only, and this narrows it again to the *admin* — the person
 * whose account the credential belongs to. The two are usually the same person and are not
 * the same fact: a space can have a second owner, and the credential is still one
 * individual's (DESIGN.md §3.4). Without this line, promoting somebody to owner would
 * silently hand them a read-only window onto the admin's entire Drive.
 *
 * A system context (the command-line import) is exempt, as it is everywhere else: it has no
 * user, it is not browsing, and it is invoked by whoever holds the server's credentials.
 */
async function assertMayImport(ctx: AnyContext): Promise<void> {
  assertCan(ctx, 'document.import');

  const space = await readInSpace(ctx, (repos) => repos.space.get());

  /*
   * The setting is checked before the identity, and for a system context too.
   *
   * It is the space saying whether this app may reach into an existing Drive folder at all,
   * so it holds against every caller including the command line — a space that turned the
   * option off should not find its folders being read by a cron somebody wired up. Note that
   * it gates *this* door only: `importDocument` is untouched by it, because a person
   * uploading files from their own computer is not using anybody's Google grant.
   */
  if (!(space?.driveImportEnabled ?? DEFAULT_DRIVE_IMPORT_ENABLED)) {
    throw new DocumentError('drive_import_disabled');
  }

  if (isSystemContext(ctx)) return;
  if (!space || space.adminUserId !== ctx.userId) throw new DocumentError('not_the_admin');
}

export interface ImportReadiness {
  /** Whether the space has turned the option on at all. Off by default. */
  enabled: boolean;
  /** Whether this user may point the app at a folder — owner, and the admin themselves. */
  allowed: boolean;
  /** Whether the admin has approved reading folders the app did not create. */
  connected: boolean;
}

/**
 * Whether the Drive half of the import screen can work, answered before it is tried.
 *
 * Three separate questions, kept separate because each has a different answer on screen. A
 * space that has not enabled the option should be shown the switch and what it means, not a
 * folder browser. A member who is not the admin should be told this is the admin's job, not
 * offered a consent link that would ask them to hand over *their* Drive. And an admin who
 * has not granted the scope should get the link with the explanation, not a failed listing.
 */
export async function importReadiness(ctx: AnyContext): Promise<ImportReadiness> {
  assertCan(ctx, 'space.read');

  const space = await readInSpace(ctx, (repos) => repos.space.get());
  if (!space) return { enabled: false, allowed: false, connected: false };

  const allowed = can(ctx, 'document.import') && (isSystemContext(ctx) || space.adminUserId === ctx.userId);

  // Asked for even when the option is off, on purpose: a space that turned it off after
  // granting the scope still has the grant, and the screen has to be able to say so and
  // tell the person how to take it back. A toggle that went quiet about it would leave
  // them believing they had revoked something they had not.
  const granted = await getProviderConnection().grantedCapabilities({ userId: space.adminUserId });

  return { enabled: space.driveImportEnabled, allowed, connected: granted.includes('import') };
}

/** Sub-folders of `parentId`, or the top of the admin's Drive when it is null. */
export async function listImportFolders(
  ctx: AnyContext,
  parentId: string | null,
): Promise<ImportFolder[]> {
  await assertMayImport(ctx);
  return getImportSource().listFolders(ctx, parentId);
}

export interface ImportListing {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  /** Whether this app can do anything with it, decided here rather than on the screen. */
  importable: boolean;
}

/**
 * What is in a folder, and which of it this app can take.
 *
 * Everything is returned, importable or not. A folder of forty files where thirty-one are
 * importable is a fact the person about to press the button needs; a list quietly filtered
 * down to thirty-one looks like a folder with thirty-one files in it.
 */
export async function listImportFiles(ctx: AnyContext, folderId: string): Promise<ImportListing[]> {
  await assertMayImport(ctx);

  const files = await getImportSource().listFiles(ctx, folderId);
  return files.map((file) => {
    const type = isStorableDocumentType(file.mimeType)
      ? normalizeMediaType(file.mimeType)
      : (typeForFileName(file.name) ?? normalizeMediaType(file.mimeType));

    return {
      id: file.id,
      name: file.name,
      mimeType: type,
      sizeBytes: file.sizeBytes,
      importable:
        isStorableDocumentType(type) &&
        isSupportedScanType(type) &&
        (file.sizeBytes ?? 0) <= MAX_IMPORT_BYTES,
    };
  });
}

/**
 * One file out of the folder and into the space.
 *
 * The bytes go provider → server → Drive and never through the browser, which is the point
 * of doing it this way: the client sends an id and gets an outcome back, so importing a
 * 12 MB scan costs the person on a phone nothing but the wait.
 */
export async function importFromSource(
  ctx: AnyContext,
  input: { fileId: string; fileName: string },
  opts: { firstPageOnly?: boolean } = {},
): Promise<ImportOutcome> {
  await assertMayImport(ctx);

  const blob = await getImportSource().read(ctx, input.fileId);
  const data =
    blob.data instanceof Uint8Array
      ? blob.data
      : new Uint8Array(await new Response(blob.data).arrayBuffer());

  return importDocument(ctx, { data, mimeType: blob.mimeType, fileName: input.fileName }, opts);
}

export async function listDocuments(ctx: AnyContext, limit = 50) {
  assertCan(ctx, 'document.read');
  return readInSpace(ctx, (repos) => repos.documents.list({ limit }));
}

/**
 * The file list: what matches, in the order asked for.
 *
 * `tags` are conjunctive and `sort` defaults to when the document arrived — see
 * `documents.search` and `DocumentSort` in the repositories for why each is the way it is.
 */
export async function searchDocuments(
  ctx: AnyContext,
  query: { text?: string; tags?: readonly string[]; sort?: DocumentSort; limit?: number },
) {
  assertCan(ctx, 'document.read');
  return readInSpace(ctx, (repos) => repos.documents.search(query));
}

/**
 * Documents dated inside a window, for the month view.
 *
 * The dates are the ones on the documents themselves — the day of the test, the visit, the
 * letter — not the day someone got round to scanning them. That is the date worth putting on
 * a calendar: it is what actually happened that week.
 *
 * Bounds are `YYYY-MM-DD` strings rather than instants, because `docDate` has no instant
 * behind it. Documents whose date is partial or missing are not returned; they cannot be
 * placed on a day, and they remain findable in the קבצים tab like everything else.
 */
export async function listDocumentsByDate(
  ctx: AnyContext,
  range: { from: string; to: string; limit?: number },
) {
  assertCan(ctx, 'document.read');
  return readInSpace(ctx, (repos) => repos.documents.inDateRange(range));
}

/**
 * Documents the extraction dated to a month but not to a day, for the strip under the grid.
 *
 * These are the documents `listDocumentsByDate` cannot return: `doc_date` is text because
 * extraction is often partial (DESIGN.md §6), and a month has no cell for "sometime in
 * August". Showing them beside the grid rather than dropping them is the honest version —
 * the app knows the month, says so, and does not guess a day.
 *
 * A document with no date at all belongs to no month and is not here. Attributing it to one
 * would be inventing a fact about a medical record; it stays in the files tab.
 */
export async function listDocumentsWithoutDay(ctx: AnyContext, month: string) {
  assertCan(ctx, 'document.read');
  return readInSpace(ctx, (repos) => repos.documents.datedToMonth({ month }));
}

export class DocumentError extends Error {
  constructor(
    readonly reason:
      | 'not_found'
      | 'unsupported_type'
      | 'conflict'
      | 'invalid_date'
      | 'empty_name'
      /** Asked to read a document with no pages in it. Only reachable by a caller bug. */
      | 'empty_scan'
      /** Reading somebody else's Drive through this space's credential. See `assertMayImport`. */
      | 'not_the_admin'
      /** The space has not turned the Drive import option on. Off is the default. */
      | 'drive_import_disabled',
  ) {
    super(`Document operation refused: ${reason}`);
    this.name = 'DocumentError';
  }
}

/** What a person may correct after the fact. Everything else about a document is not opinion. */
export interface DocumentEdit {
  name: string;
  docType: string | null;
  docDate: string | null;
  hospital: string | null;
  doctor: string | null;
  tags: string[];
  actionRequired: boolean;
}

/**
 * A `doc_date` the rest of the app can actually use.
 *
 * The column is text because extraction is often partial (DESIGN.md §6), and the calendar
 * depends on precisely which of the three shapes it holds: ten characters go on a day, seven
 * go in the month strip, four belong to a year and appear on no calendar at all. So this
 * accepts all three and rejects everything else — a free-text date would be silently
 * unplaceable rather than obviously wrong.
 *
 * The full form is also checked for being a date that exists. `2026-02-31` matches the shape,
 * survives `new Date()` by rolling over into March, and would then be drawn on the wrong day.
 */
export function normalizeDocDate(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value) return null;

  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value)) throw new DocumentError('invalid_date');

  if (value.length === 10) {
    const [year, month, day] = value.split('-').map(Number);
    const asDate = new Date(Date.UTC(year, month - 1, day));
    const roundTrips =
      asDate.getUTCFullYear() === year &&
      asDate.getUTCMonth() === month - 1 &&
      asDate.getUTCDate() === day;
    if (!roundTrips) throw new DocumentError('invalid_date');
  } else if (value.length === 7) {
    const month = Number(value.slice(5));
    if (month < 1 || month > 12) throw new DocumentError('invalid_date');
  }

  return value;
}

/**
 * Correcting what extraction got wrong.
 *
 * This exists because extraction is a guess and the app had no way to fix one: a wrong doctor
 * name or a date read off the print footer instead of the letter meant re-scanning the whole
 * document. At one document that is a nuisance; at a folder of them it is the difference
 * between an archive worth having and one nobody trusts.
 *
 * Two things it deliberately does not touch:
 *
 * `extractedText` — what the document says, not what a person decided it says. It is the
 * search index, and it must keep agreeing with the file it points at.
 *
 * `document.action_required` is **not** re-emitted when the flag goes false → true. That
 * event exists so M2 can propose a calendar item, and a proposal needs the one-sentence
 * `actionSummary` that only extraction produces — it is not a column, so an edit does not
 * have one. Ticking the box here corrects the record; it does not schedule anything, and
 * unticking it deliberately leaves any action item already proposed alone. If proposing from
 * an edit is ever wanted, the summary has to become a column first.
 */
export async function updateDocument(
  ctx: AnyContext,
  documentId: string,
  expectedVersion: number,
  edit: DocumentEdit,
) {
  assertCan(ctx, 'document.update');

  const name = edit.name.trim();
  if (!name) throw new DocumentError('empty_name');
  const docDate = normalizeDocDate(edit.docDate);

  const updated = await withSpace(ctx, async (uow) => {
    const existing = await uow.repos.documents.get(documentId);
    // Absent, another space's, or already deleted — indistinguishable to the caller, which
    // is the same answer `getDocumentDetail` gives and for the same reason.
    if (!existing) throw new DocumentError('not_found');

    const row = await uow.repos.documents.update(documentId, expectedVersion, {
      name,
      docType: edit.docType?.trim() || null,
      docDate,
      hospital: edit.hospital?.trim() || null,
      doctor: edit.doctor?.trim() || null,
      actionRequired: edit.actionRequired,
    });
    // The row existed a line ago, so the only way the versioned update matches nothing is
    // that somebody else wrote to it in between.
    if (!row) throw new DocumentError('conflict');

    await uow.repos.tags.replaceForDocument(documentId, edit.tags);

    // Names the act and the document, never a field value: an activity log that recorded
    // the old and new doctor would be a second copy of the medical metadata (DESIGN.md §7.2).
    uow.emit(event('document.updated', 'document', documentId, `עודכנו פרטי מסמך: ${row.name}`));

    return row;
  });

  log.info('document.updated', {
    module: 'documents',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    documentId,
    outcome: 'success',
  });

  return updated;
}

/**
 * One document with its tags, for the file screen.
 *
 * `extractedText` is deliberately dropped on the way out: it is the entire OCR of a medical
 * record, it is only there to be searched, and a page that renders it would put a lab result
 * into a browser cache and a screenshot for no gain. What the screen shows is the metadata
 * and the file itself.
 */
export async function getDocumentDetail(ctx: AnyContext, documentId: string) {
  assertCan(ctx, 'document.read');

  return readInSpace(ctx, async (repos) => {
    const row = await repos.documents.get(documentId);
    // A soft-deleted document reads as absent (the repository filters it), and so does one
    // belonging to another space. The caller cannot tell them apart, which is correct.
    if (!row) throw new DocumentError('not_found');

    const tagRows = await repos.tags.forDocument(documentId);
    return {
      id: row.id,
      name: row.name,
      docType: row.docType,
      docDate: row.docDate,
      hospital: row.hospital,
      doctor: row.doctor,
      mimeType: row.mimeType,
      storageProvider: row.storageProvider,
      actionRequired: row.actionRequired,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      /** What the edit form sends back, so a stale form conflicts instead of overwriting. */
      version: row.version,
      tags: tagRows.map((tag) => tag.name),
    };
  });
}

/**
 * The stored file itself, for viewing or downloading.
 *
 * Served through the app rather than as a Drive link, for the same reason recordings are
 * (DESIGN.md §3.4): native access is incidental — it exists so files appear on a member's
 * phone, not as this app's delivery path — so a member whose Drive share is pending or
 * failed still opens their own documents.
 */
export async function readDocumentFile(ctx: AnyContext, documentId: string) {
  assertCan(ctx, 'document.read');

  const row = await readInSpace(ctx, (repos) => repos.documents.get(documentId));
  if (!row) throw new DocumentError('not_found');

  const blob = await getFileStorage().download(ctx, row.storageRef);

  /*
   * The row's type is authoritative over Drive's, which answers with something vaguer often
   * enough to matter — but it is authoritative only within the allowlist. `saveDocument`
   * refuses anything else, so this narrowing is unreachable through the app today; it is
   * here because it is the last thing between a stored string and a `Content-Type` header
   * on this origin, and because rows outlive the code that wrote them. `null` tells the
   * route to serve the bytes as an opaque download rather than to name them.
   */
  return {
    blob,
    mimeType: servableTypeFor(row.mimeType),
    fileName: storedFileName(row.name, extensionFor(row.mimeType)),
  };
}

export async function listTags(ctx: AnyContext) {
  assertCan(ctx, 'document.read');
  return readInSpace(ctx, (repos) => repos.tags.list());
}

/**
 * The tags worth offering as a filter: those a living document still carries, commonest
 * first, with how many carry each.
 *
 * The count is shown rather than kept internal because it is what makes the filter
 * choosable — a tag on thirty documents and a tag on one are the same word otherwise, and
 * extraction produces plenty of both.
 */
export async function listTagFilters(ctx: AnyContext) {
  assertCan(ctx, 'document.read');
  return readInSpace(ctx, (repos) => repos.tags.inUse());
}

export async function deleteDocument(ctx: AnyContext, documentId: string) {
  assertCan(ctx, 'document.delete');
  return withSpace(ctx, async (uow) => {
    const existing = await uow.repos.documents.get(documentId);
    if (!existing) return null;
    const row = await uow.repos.documents.softDelete(documentId);
    // The summary is written now and never recomputed, so the history stays readable
    // after the document it refers to is gone (DESIGN.md §7.2).
    uow.emit(event('document.deleted', 'document', documentId, `נמחק מסמך: ${existing.name}`));
    return row;
  });
}

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

export const roleEnum = pgEnum('role', ['owner', 'editor', 'viewer']);
export const shareStatusEnum = pgEnum('share_status', ['pending', 'active', 'failed', 'not_applicable']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'integration']);
export const storageProviderEnum = pgEnum('storage_provider', ['google-drive', 's3', 'vercel-blob', 'local']);
export const eventKindEnum = pgEnum('event_kind', ['appointment', 'reminder', 'task']);
export const eventStatusEnum = pgEnum('event_status', ['scheduled', 'done', 'cancelled']);
export const calendarSyncEnum = pgEnum('calendar_sync_status', ['pending', 'synced', 'failed']);
export const actionSourceEnum = pgEnum('action_source', ['document', 'correspondence', 'visit']);
/**
 * `ignored` is the fourth resolution and the only one that is not a claim about the care
 * itself. `dismissed` says the action was never needed and `done` says it happened; both
 * are statements a later reader will trust. `ignored` says only "not now, stop showing me
 * this" — which is what people actually want for a proposal extraction got wrong or that
 * nobody is ready to decide on, and which they would otherwise express by dismissing it
 * and putting a false fact into a medical record.
 */
export const actionStatusEnum = pgEnum('action_status', [
  'proposed',
  'accepted',
  'dismissed',
  'done',
  'ignored',
]);
export const logLevelEnum = pgEnum('log_level', ['debug', 'info', 'warn', 'error']);
export const contactKindEnum = pgEnum('contact_kind', ['doctor', 'clinic', 'hmo']);
export const flowTypeEnum = pgEnum('flow_type', ['prescription_conversion', 'commitment_form', 'general_inquiry']);
export const correspondenceStatusEnum = pgEnum('correspondence_status', [
  'draft',
  'sent',
  'awaiting_reply',
  'done',
  'cancelled',
]);

/* ------------------------------------------------------------------ Auth.js tables */

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

/**
 * Auth.js stores the Google refresh token here. The space's Google credential is not
 * duplicated elsewhere — the Drive/Calendar/Gmail adapters resolve it by looking up the
 * account row for the space's `adminUserId`. One credential per space (DESIGN.md §3.4).
 */
export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

/* ------------------------------------------------------------- Tenancy: spaces */

export const spaces = pgTable('spaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  /** Who the records are about. Independent of the member list — see DESIGN.md §3.1. */
  subjectName: text('subject_name').notNull(),
  adminUserId: uuid('admin_user_id').notNull().references(() => users.id),
  storageProvider: storageProviderEnum('storage_provider').default('google-drive').notNull(),
  driveFolderId: text('drive_folder_id'),
  googleCalendarId: text('google_calendar_id'),
  /** False once the admin's token stops working, so the UI can surface it loudly. */
  googleConnectionHealthy: boolean('google_connection_healthy').default(false).notNull(),
  /**
   * Read only the first page of a document, or all of it.
   *
   * Default **true**, which is a deliberate choice about what these documents are rather
   * than a timid default. A discharge letter's identity — its date, its institution, its
   * doctor, what it is — is on page one; pages two and three are the appendix, the
   * reference ranges, the printed consent text. Reading them costs a model call
   * proportional to the page count and changes the extracted fields rarely.
   *
   * The price is real and is stated on the settings screen: `extracted_text` then holds
   * the first page only, so a phrase that appears solely on page four is not searchable.
   * A space that would rather pay for that turns this off. The stored *file* is always
   * whole either way — this bounds what is read, never what is kept.
   */
  ocrFirstPageOnly: boolean('ocr_first_page_only').default(true).notNull(),
  /**
   * Whether this space may import from a folder in the admin's existing Drive.
   *
   * Default **false**, and off is the state a space stays in unless somebody deliberately
   * turns it on. It is the only feature here that needs a Google grant wider than "files
   * this app created" (`DRIVE_IMPORT_SCOPE`), and a capability like that should be a thing
   * a person switched on, on a screen that told them what it costs and how to undo it —
   * not something that was simply available one day.
   *
   * It is a real gate, not a hidden button: `assertMayImport` refuses to list or read a
   * folder while this is false, and the consent route refuses to even ask Google for the
   * scope. Turning it back off stops the app using the permission immediately — it cannot
   * revoke the grant itself, which is Google's to give back and is why the settings screen
   * spells out where.
   */
  driveImportEnabled: boolean('drive_import_enabled').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spaceMembers = pgTable(
  'space_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    /** Exact grant ids, so revocation deletes what it created rather than guessing. */
    drivePermissionId: text('drive_permission_id'),
    calendarAclId: text('calendar_acl_id'),
    shareStatus: shareStatusEnum('share_status').default('pending').notNull(),
    /**
     * Set when a removal began but a native grant could not be revoked.
     *
     * The row deliberately survives that failure. Deleting it would throw away the very
     * permission ids the retry needs, leaving an ex-member holding native Drive access
     * with nothing in the database that remembers it — the worst failure in this design
     * (DESIGN.md §3.4). App access stops immediately regardless: `app_spaces_for_user`
     * skips rows with this set, so the membership is inert while it waits to be finished.
     */
    removalRequestedAt: timestamp('removal_requested_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('space_members_space_user_idx').on(table.spaceId, table.userId),
    index('space_members_user_idx').on(table.userId),
  ],
);

export const spaceInvites = pgTable(
  'space_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    /** Only the hash is stored; the raw token exists solely in the invitation link. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    invitedByUserId: uuid('invited_by_user_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('space_invites_space_idx').on(table.spaceId)],
);

/* --------------------------------------------------------------- M1: documents */

/**
 * `hospital` and `doctor` are plain text here rather than references to a contacts
 * table. Extraction produces names, and normalizing them into contacts only pays off
 * once appointments need to link to the same doctor — that arrives with M2, and the
 * migration is a backfill rather than a redesign.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    docType: text('doc_type'),
    docDate: text('doc_date'), // ISO date; text because extraction is often partial
    hospital: text('hospital'),
    doctor: text('doctor'),
    storageRef: text('storage_ref').notNull(),
    storageProvider: storageProviderEnum('storage_provider').notNull(),
    mimeType: text('mime_type').notNull(),
    /** OCR output. Searched via the tsvector index created in drizzle/policies.sql. */
    extractedText: text('extracted_text'),
    /**
     * SHA-256 of the bytes that were stored, hex. Written by the bulk import and by nothing
     * else, which is why it is nullable — every document filed before this column existed,
     * and every one added through the scan form, has none.
     *
     * It exists because bulk import is the one path where a person can spend a model call
     * per file on a folder they already imported. DESIGN.md §12 defers duplicate detection
     * in general and this does not answer it: identical bytes is the narrowest possible
     * notion of "the same document", and the same lab result re-downloaded from the portal
     * is a different file. It catches re-running an import, which is the mistake that
     * actually happens and costs money.
     *
     * Not unique. A conflicting insert would turn a duplicate into an error at the end of an
     * expensive pipeline; the import checks first and skips instead, and a space that
     * genuinely wants the same bytes twice is not the database's business to refuse.
     */
    contentHash: text('content_hash'),
    actionRequired: boolean('action_required').default(false).notNull(),
    /** What the model proposed, kept beside what the user confirmed. */
    extractionRaw: jsonb('extraction_raw').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    /** Soft delete: in a shared space one member must not irreversibly destroy another's work. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('documents_space_date_idx').on(table.spaceId, table.docDate.desc()),
    index('documents_space_created_idx').on(table.spaceId, table.createdAt.desc()),
    // The import's "have I seen these bytes before?" lookup, once per file. Partial, because
    // only imported documents carry a hash and the index should be no larger than they are.
    index('documents_space_hash_idx')
      .on(table.spaceId, table.contentHash)
      .where(sql`${table.contentHash} is not null`),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
  },
  (table) => [uniqueIndex('tags_space_name_idx').on(table.spaceId, table.name)],
);

export const documentTags = pgTable(
  'document_tags',
  {
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
    /** Carried so RLS can guard the join table without walking to its parents. */
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.tagId] }),
    index('document_tags_tag_idx').on(table.tagId),
  ],
);

/* ------------------------------------------------- M2: events and action items */

/**
 * The app's schedule, and the source of truth for it. The space's Google calendar is a
 * one-way projection of this table (DESIGN.md §5, M2) — nothing is ever read back, so
 * there is no conflict to resolve.
 *
 * DESIGN.md §6 names the time column `due_at`. It is `starts_at` here, with `ends_at`
 * beside it, because an appointment has a duration and a reminder does not — one pair of
 * columns serves both, and it matches `CalendarEventInput` so the adapter needs no
 * translation.
 *
 * `contact_id` from §6 is deliberately absent: nothing populates a contacts table yet,
 * and adding it now would be an empty column with a foreign key to an empty table. It
 * arrives with M3, as a backfill from `documents.doctor`.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    kind: eventKindEnum('kind').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    allDay: boolean('all_day').default(false).notNull(),
    location: text('location'),
    /** Cancelling rather than deleting: a cancelled appointment is history worth keeping. */
    status: eventStatusEnum('status').default('scheduled').notNull(),
    /** Id in the space's Google calendar. Single ref — one calendar serves every member. */
    externalCalendarRef: text('external_calendar_ref'),
    /** `pending` also covers "no calendar connected yet", which is a retryable state. */
    calendarSyncStatus: calendarSyncEnum('calendar_sync_status').default('pending').notNull(),
    /** The document that prompted this, when there was one. */
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('events_space_starts_idx').on(table.spaceId, table.startsAt),
    index('events_space_status_idx').on(table.spaceId, table.status),
  ],
);

/**
 * Things the app noticed and is *proposing*, separate from things that are actually
 * scheduled. The split is the product rule in DESIGN.md §11: the app never puts an
 * entry in someone's calendar on its own, so an extracted "book a follow-up" lands here
 * as a suggestion and only becomes an `events` row once a person picks a time.
 *
 * `source_id` is polymorphic and therefore carries no foreign key. Documents are
 * soft-deleted, so a dangling reference means "the document was removed", which the
 * denormalized `title` already survives.
 */
export const actionItems = pgTable(
  'action_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    source: actionSourceEnum('source').notNull(),
    sourceId: uuid('source_id'),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: actionStatusEnum('status').default('proposed').notNull(),
    /** Set when accepting turns the proposal into a scheduled event. */
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('action_items_space_status_idx').on(table.spaceId, table.status, table.createdAt.desc())],
);

/* ------------------------------------------------------- M3: HMO communications */

/**
 * People and institutions the space deals with.
 *
 * Deferred through Phases 1 and 2 on the grounds that nothing populated it, which was the
 * right call and has now expired: correspondence has to be addressed to someone, and
 * "someone" needs to survive being typed once. It arrives as DESIGN.md §6 said it would,
 * backfilled from the doctor and hospital names extraction has been writing onto documents
 * all along (`npm run backfill:contacts`).
 *
 * `email` is nullable because most of these are known by name long before anyone learns how
 * to write to them — a doctor from a letterhead is still worth recording.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    kind: contactKindEnum('kind').notNull(),
    name: text('name').notNull(),
    specialty: text('specialty'),
    phone: text('phone'),
    email: text('email'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Names arrive from extraction, so the same doctor would otherwise accumulate a row per
    // document. Unique per kind, because a clinic and a doctor can share a name.
    uniqueIndex('contacts_space_kind_name_idx').on(table.spaceId, table.kind, table.name),
  ],
);

/**
 * A request to the kupah, and what became of it.
 *
 * `body` holds the composed message. That is health content, and it lives here for the same
 * reason `documents.extracted_text` does: the table is space-scoped and RLS-guarded, and the
 * alternative — not keeping what was sent — makes the tracker useless the moment anyone asks
 * "what exactly did we ask for?". It must never reach an application log (DESIGN.md §7.1) or
 * an activity summary.
 *
 * `sent_by_user_id` is the point of the whole table in a shared space. Correspondence leaves
 * from the admin's mailbox whoever wrote it (DESIGN.md §3.4), so without this column the
 * answer to "who sent that to the kupah?" would be "the admin", always, and wrongly.
 *
 * `thread_ref` is what Gmail returned when the message was sent. Nothing reads it yet — the
 * app holds `gmail.send` and cannot look at a mailbox — but it is the anchor any future
 * reply detection would need, and it is free to keep now and impossible to reconstruct later.
 */
export const correspondence = pgTable(
  'correspondence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    flowType: flowTypeEnum('flow_type').notNull(),
    status: correspondenceStatusEnum('status').default('draft').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Denormalized: the address it actually went to, even if the contact later changes. */
    recipientEmail: text('recipient_email'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    threadRef: text('thread_ref'),
    messageRef: text('message_ref'),
    sentByUserId: uuid('sent_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('correspondence_space_status_idx').on(table.spaceId, table.status, table.createdAt.desc()),
  ],
);

/**
 * Which documents went out with a request.
 *
 * A join table rather than a column because a טופס 17 request routinely carries a referral
 * *and* a previous discharge letter, and because the same document is attached to several
 * requests over the course of one illness. `space_id` is carried so RLS can guard the join
 * without walking to its parents, exactly as `document_tags` does.
 */
export const correspondenceAttachments = pgTable(
  'correspondence_attachments',
  {
    correspondenceId: uuid('correspondence_id').notNull().references(() => correspondence.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.correspondenceId, table.documentId] }),
    index('correspondence_attachments_document_idx').on(table.documentId),
  ],
);

/* ------------------------------------------------------- M4: visit companion */

/**
 * Questions to ask at an appointment.
 *
 * The point of this table in a shared space is that *any* member can add one, so the
 * person who actually attends walks in with the whole family's questions rather than only
 * their own (DESIGN.md §5, M4). `created_by` is therefore load-bearing rather than
 * bookkeeping: at the visit it tells the attendee which question came from the sibling who
 * could not be there.
 *
 * Both links are nullable and both are useful. A question tied to an appointment is asked
 * at that appointment; one tied only to a contact is asked next time that doctor is seen,
 * whenever that turns out to be. A question with neither is just a note to raise sometime.
 */
export const questions = pgTable(
  'questions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    /** The appointment it belongs to, when it belongs to one. */
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    text: text('text').notNull(),
    /** Ticked off in the room. Separate from having an answer — plenty are asked and not
     *  really answered, and pretending otherwise loses the fact that it came up. */
    asked: boolean('asked').default(false).notNull(),
    answerSummary: text('answer_summary'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('questions_space_event_idx').on(table.spaceId, table.eventId),
    index('questions_space_asked_idx').on(table.spaceId, table.asked, table.createdAt),
  ],
);

/**
 * A recorded visit.
 *
 * `transcript_ref` and `summary_doc_id` exist and are unpopulated, which is deliberate and
 * temporary. Phase 5 records and stores audio but does not transcribe it: DESIGN.md §12
 * wants Hebrew speech-to-text compared on real clinic audio before it is trusted, and there
 * is no such audio until this table has some. Capture is also the half that cannot be
 * repeated — a visit happens once — so it is the half worth having first. The columns are
 * here because a transcript belongs to the visit whenever it arrives, and adding them later
 * would be a migration for no reason.
 *
 * `recorded_by_user_id` is not decoration either. The product rule is that the person
 * recording is the person in the room, which no app can verify — so what it can do is
 * record who claimed it, and say so.
 */
export const visits = pgTable(
  'visits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    /** Opaque provider id for the audio, exactly as `documents.storage_ref` (DESIGN.md §4). */
    recordingRef: text('recording_ref'),
    recordingProvider: storageProviderEnum('recording_provider'),
    recordingMimeType: text('recording_mime_type'),
    recordingDurationMs: integer('recording_duration_ms'),
    recordingBytes: integer('recording_bytes'),
    /** Both await a transcription provider — see the note above. */
    transcriptRef: text('transcript_ref'),
    summaryDocId: uuid('summary_doc_id').references(() => documents.id, { onDelete: 'set null' }),
    notes: text('notes'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('visits_space_event_idx').on(table.spaceId, table.eventId)],
);

/* ------------------------------------------------------ Observability: activity log */

/**
 * Append-only. The application role is granted INSERT and SELECT and nothing else —
 * see the RLS migration. Written inside the same transaction as the state change it
 * describes, so the two cannot diverge.
 */
export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: actorTypeEnum('actor_type').default('user').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    summary: text('summary').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('activity_log_space_created_idx').on(table.spaceId, table.createdAt.desc()),
    index('activity_log_entity_idx').on(table.entityType, table.entityId),
  ],
);

/**
 * Application logs that outlive the process — the durable half of DESIGN.md §7.1.
 *
 * The other half is unchanged: every `log.*` call still goes to stdout as JSON, which is
 * what a drain reads and what `LOG_DIR` appends to a file. What stdout cannot answer is
 * "what did this space cost last month", because on a serverless platform the process that
 * knew is gone. So a *curated* subset lands here: LLM calls, warnings, and errors.
 *
 * Three properties this table is built around:
 *
 * **It carries no health content.** The rows are written from `LogFields`, which is an
 * allowlist — a field nobody thought about is dropped rather than stored (§7.1). The
 * columns below are that allowlist, so a prompt, a document name, or a subject name has no
 * column to land in even if a caller tries.
 *
 * **`space_id` is not null, and that is a filter, not an oversight.** Logs with no space —
 * bootstrap, migrations, a cron with nobody's data in it — stay on stdout. It means every
 * row here is guarded by one RLS predicate with no null case to reason about, and it means
 * the usage screen never has to explain a row that belongs to no one.
 *
 * **Append-only, like `activity_log`.** The application role is granted INSERT and SELECT
 * and nothing else, so a bug cannot rewrite the record of what was spent.
 */
export const appLog = pgTable(
  'app_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    level: logLevelEnum('level').notNull(),
    /** The event name passed to `log.info(...)`, e.g. `llm.extraction.completed`. */
    event: text('event').notNull(),
    module: text('module'),
    requestId: text('request_id'),
    outcome: text('outcome'),

    // Integration and LLM metadata. Never prompts, completions, or their contents.
    provider: text('provider'),
    operation: text('operation'),
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /**
     * Priced at write time from `core/llm/pricing.ts`, not at read time. A tariff change
     * must not silently rewrite what last quarter cost, and the row is the receipt.
     * Null when the model has no published price in the table — the screen says so rather
     * than showing a confident zero.
     */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),

    durationMs: integer('duration_ms'),
    statusCode: integer('status_code'),
    errorType: text('error_type'),
    errorMessage: text('error_message'),

    /**
     * The remaining allowlisted fields — entity ids, counts, character totals — as they
     * were logged. Ids and numbers only, by construction: the sanitizer runs first.
     */
    fields: jsonb('fields').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('app_log_space_created_idx').on(table.spaceId, table.createdAt.desc()),
    // The usage screen's query: this space's model calls, newest first. Partial, because
    // model calls are a small minority of the rows and the index should be too.
    index('app_log_space_model_idx')
      .on(table.spaceId, table.createdAt.desc())
      .where(sql`${table.model} is not null`),
  ],
);

export type ContactRow = typeof contacts.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type VisitRow = typeof visits.$inferSelect;
export type CorrespondenceRow = typeof correspondence.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ActionItemRow = typeof actionItems.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;
export type SpaceMemberRow = typeof spaceMembers.$inferSelect;
export type SpaceInviteRow = typeof spaceInvites.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type AppLogRow = typeof appLog.$inferSelect;

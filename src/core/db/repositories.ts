import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { isSystemContext, type AnyContext } from '@/core/context/space-context';
import type { Role } from '@/core/domain/types';
import {
  actionItems,
  activityLog,
  appLog,
  contacts,
  correspondence,
  correspondenceAttachments,
  documentTags,
  documents,
  events,
  questions,
  visits,
  spaceInvites,
  spaceMembers,
  spaces,
  tags,
  users,
} from './schema';
import type { Transaction } from './client';

/**
 * What can become of a proposal. `ignored` joins the three original resolutions and is
 * deliberately not a synonym for any of them — see the enum in `schema.ts`.
 */
export type ActionItemStatus = 'proposed' | 'accepted' | 'dismissed' | 'done' | 'ignored';

/**
 * The orders the file list can be read in.
 *
 * `added` is when the document reached the app; the two `date` orders are the date on the
 * document itself. They are different questions — "what did I scan last night" against
 * "what happened that autumn" — and a folder of records imported in one afternoon makes the
 * difference stark: by `added` they are one indistinguishable block, by `date` they are a
 * history.
 */
export type DocumentSort = 'added' | 'date-desc' | 'date-asc' | 'name';

/** As many tag filters as one query will carry. See `documents.search`. */
export const MAX_TAG_FILTERS = 8;

/**
 * `order by` for each of them, with `created_at` underneath as the tie-break so that a
 * page of documents sharing a date, or no date, comes back in a stable order rather than
 * whatever the planner felt like this time.
 *
 * `doc_date` is text and often partial (DESIGN.md §6), which the string comparison handles
 * about as well as anything could: `2026-07` sorts beside July's days rather than at one end
 * of the list, landing after them descending and before them ascending. What matters more is
 * `nulls last` in *both* directions — a document nobody dated is not the oldest thing in the
 * archive, and Postgres would otherwise put the undated pile on top of the descending order.
 */
function documentOrder(sort: DocumentSort) {
  switch (sort) {
    case 'date-desc':
      return [sql`${documents.docDate} desc nulls last`, desc(documents.createdAt)];
    case 'date-asc':
      return [sql`${documents.docDate} asc nulls last`, desc(documents.createdAt)];
    // Whatever the database's collation says, which for Hebrew is the alphabet.
    case 'name':
      return [asc(documents.name), desc(documents.createdAt)];
    default:
      return [desc(documents.createdAt)];
  }
}

/**
 * Space-scoped repositories.
 *
 * Every query built here carries `space_id = ctx.spaceId`, injected by the factory
 * rather than passed by the caller. There is no parameter for a module to forget and
 * no overload that omits it — that is the whole point (DESIGN.md §3.5, layer 1).
 */
export function createRepositories(tx: Transaction, ctx: AnyContext) {
  const inSpace = eq(spaces.id, ctx.spaceId);

  /**
   * Shared by `tags.attach` and `tags.replaceForDocument`.
   *
   * A local function rather than one method calling the other through `this`: these
   * repositories are a bare object literal, so `this` survives `repos.tags.attach(…)` and
   * quietly breaks the moment anyone destructures it.
   */
  /**
   * The predicate every usage query shares: this space, and only rows that describe a
   * model call. Local for the same reason `attachTags` is — these repositories are a bare
   * object literal, and `this` does not survive being destructured.
   */
  function usageConditions(since?: Date) {
    const conditions = [eq(appLog.spaceId, ctx.spaceId), sql`${appLog.model} is not null`];
    if (since) conditions.push(gte(appLog.createdAt, since));
    return conditions;
  }

  async function attachTags(documentId: string, names: readonly string[]) {
    const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (cleaned.length === 0) return [];

    const rows = await tx
      .insert(tags)
      .values(cleaned.map((name) => ({ spaceId: ctx.spaceId, name })))
      .onConflictDoUpdate({
        target: [tags.spaceId, tags.name],
        set: { name: sql`excluded.name` },
      })
      .returning();

    await tx
      .insert(documentTags)
      .values(rows.map((tag) => ({ documentId, tagId: tag.id, spaceId: ctx.spaceId })))
      .onConflictDoNothing();

    return rows;
  }

  return {
    space: {
      async get() {
        const [row] = await tx.select().from(spaces).where(inSpace).limit(1);
        return row ?? null;
      },

      async setGoogleResources(input: {
        driveFolderId?: string;
        googleCalendarId?: string;
        googleConnectionHealthy?: boolean;
      }) {
        const [row] = await tx.update(spaces).set(input).where(inSpace).returning();
        return row;
      },

      /**
       * What the space has chosen about how it works, as opposed to what Google handed it.
       * Separate from `setGoogleResources` because these are a person's decisions and those
       * are the connect flow's bookkeeping; nothing should be able to write one while
       * meaning the other.
       */
      async setSettings(input: { ocrFirstPageOnly?: boolean; driveImportEnabled?: boolean }) {
        const [row] = await tx.update(spaces).set(input).where(inSpace).returning();
        return row;
      },
    },

    members: {
      /**
       * Joined to `users` because every caller needs the email: the screen shows it, the
       * grant flow shares with it, and reconciliation matches Google's permission list
       * against it. A membership row on its own is an id nobody can act on.
       */
      async list() {
        return tx
          .select({
            id: spaceMembers.id,
            userId: spaceMembers.userId,
            role: spaceMembers.role,
            joinedAt: spaceMembers.joinedAt,
            drivePermissionId: spaceMembers.drivePermissionId,
            calendarAclId: spaceMembers.calendarAclId,
            shareStatus: spaceMembers.shareStatus,
            removalRequestedAt: spaceMembers.removalRequestedAt,
            email: users.email,
            name: users.name,
          })
          .from(spaceMembers)
          .innerJoin(users, eq(users.id, spaceMembers.userId))
          .where(eq(spaceMembers.spaceId, ctx.spaceId))
          .orderBy(spaceMembers.joinedAt);
      },

      async get(memberId: string) {
        const [row] = await tx
          .select({
            id: spaceMembers.id,
            userId: spaceMembers.userId,
            role: spaceMembers.role,
            drivePermissionId: spaceMembers.drivePermissionId,
            calendarAclId: spaceMembers.calendarAclId,
            shareStatus: spaceMembers.shareStatus,
            removalRequestedAt: spaceMembers.removalRequestedAt,
            email: users.email,
            name: users.name,
          })
          .from(spaceMembers)
          .innerJoin(users, eq(users.id, spaceMembers.userId))
          .where(and(eq(spaceMembers.spaceId, ctx.spaceId), eq(spaceMembers.id, memberId)))
          .limit(1);
        return row ?? null;
      },

      async findByUser(userId: string) {
        const [row] = await tx
          .select()
          .from(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, ctx.spaceId), eq(spaceMembers.userId, userId)))
          .limit(1);
        return row ?? null;
      },

      async add(input: { userId: string; role: Role }) {
        const [row] = await tx
          .insert(spaceMembers)
          .values({ spaceId: ctx.spaceId, userId: input.userId, role: input.role })
          .returning();
        return row;
      },

      async changeRole(memberId: string, role: Role) {
        const [row] = await tx
          .update(spaceMembers)
          .set({ role })
          .where(and(eq(spaceMembers.spaceId, ctx.spaceId), eq(spaceMembers.id, memberId)))
          .returning();
        return row ?? null;
      },

      /** Records the grant ids returned by Google so revocation can delete exactly them. */
      async recordShare(
        memberId: string,
        input: { drivePermissionId?: string | null; calendarAclId?: string | null; shareStatus: 'pending' | 'active' | 'failed' | 'not_applicable' },
      ) {
        const [row] = await tx
          .update(spaceMembers)
          .set(input)
          .where(and(eq(spaceMembers.spaceId, ctx.spaceId), eq(spaceMembers.id, memberId)))
          .returning();
        return row ?? null;
      },

      /**
       * Ends app access without discarding the row. `app_spaces_for_user` skips a member
       * marked this way, so they can no longer reach the space, while the permission ids
       * needed to finish revoking their native access survive for the retry.
       */
      async markRemovalRequested(memberId: string) {
        const [row] = await tx
          .update(spaceMembers)
          .set({ removalRequestedAt: new Date() })
          .where(and(eq(spaceMembers.spaceId, ctx.spaceId), eq(spaceMembers.id, memberId)))
          .returning();
        return row ?? null;
      },

      async remove(memberId: string) {
        const [row] = await tx
          .delete(spaceMembers)
          .where(and(eq(spaceMembers.spaceId, ctx.spaceId), eq(spaceMembers.id, memberId)))
          .returning();
        return row ?? null;
      },
    },

    invites: {
      /**
       * Expiry is evaluated by Postgres rather than by the caller, so "has this expired?"
       * is answered by the same clock that will refuse the token at accept time — and so
       * a server-rendered screen has no reason to read the wall clock while rendering.
       */
      async listPending() {
        return tx
          .select({
            id: spaceInvites.id,
            email: spaceInvites.email,
            role: spaceInvites.role,
            expiresAt: spaceInvites.expiresAt,
            createdAt: spaceInvites.createdAt,
            expired: sql<boolean>`${spaceInvites.expiresAt} <= now()`,
          })
          .from(spaceInvites)
          .where(and(eq(spaceInvites.spaceId, ctx.spaceId), isNull(spaceInvites.acceptedAt)))
          .orderBy(desc(spaceInvites.createdAt));
      },

      async create(input: { email: string; role: Role; tokenHash: string; expiresAt: Date; invitedByUserId: string }) {
        const [row] = await tx
          .insert(spaceInvites)
          .values({ spaceId: ctx.spaceId, ...input })
          .returning();
        return row;
      },

      /**
       * Deletes any outstanding invitation for an address. Re-inviting someone therefore
       * invalidates the link they were sent before — two live tokens for one mailbox is
       * one more than anybody needs, and the older one is the one nobody is tracking.
       */
      async revokePendingFor(email: string) {
        return tx
          .delete(spaceInvites)
          .where(
            and(
              eq(spaceInvites.spaceId, ctx.spaceId),
              eq(spaceInvites.email, email),
              isNull(spaceInvites.acceptedAt),
            ),
          )
          .returning();
      },

      async revoke(inviteId: string) {
        const [row] = await tx
          .delete(spaceInvites)
          .where(
            and(
              eq(spaceInvites.spaceId, ctx.spaceId),
              eq(spaceInvites.id, inviteId),
              isNull(spaceInvites.acceptedAt),
            ),
          )
          .returning();
        return row ?? null;
      },

      async markAccepted(inviteId: string) {
        const [row] = await tx
          .update(spaceInvites)
          .set({ acceptedAt: new Date() })
          .where(and(eq(spaceInvites.spaceId, ctx.spaceId), eq(spaceInvites.id, inviteId)))
          .returning();
        return row ?? null;
      },

      async purgeExpired() {
        return tx
          .delete(spaceInvites)
          .where(and(eq(spaceInvites.spaceId, ctx.spaceId), isNull(spaceInvites.acceptedAt), lt(spaceInvites.expiresAt, new Date())));
      },
    },

    documents: {
      async create(input: {
        name: string;
        docType?: string | null;
        docDate?: string | null;
        hospital?: string | null;
        doctor?: string | null;
        storageRef: string;
        storageProvider: 'google-drive' | 's3' | 'vercel-blob' | 'local';
        mimeType: string;
        extractedText?: string | null;
        actionRequired?: boolean;
        extractionRaw?: Record<string, unknown> | null;
        /** Only the import sets one; see the column note in `schema.ts`. */
        contentHash?: string | null;
      }) {
        const [row] = await tx
          .insert(documents)
          .values({
            spaceId: ctx.spaceId,
            createdBy: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
          })
          .returning();
        return row;
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.spaceId, ctx.spaceId), eq(documents.id, id), isNull(documents.deletedAt)))
          .limit(1);
        return row ?? null;
      },

      /**
       * A living document with exactly these bytes, if this space already has one.
       *
       * Deleted documents are excluded, deliberately: somebody who removed a mis-filed
       * import and is running it again means to bring it back, and a skip that pointed at
       * a document they cannot see would be indistinguishable from the import doing nothing.
       */
      async findByContentHash(hash: string) {
        const [row] = await tx
          .select({ id: documents.id, name: documents.name })
          .from(documents)
          .where(
            and(
              eq(documents.spaceId, ctx.spaceId),
              eq(documents.contentHash, hash),
              isNull(documents.deletedAt),
            ),
          )
          .limit(1);
        return row ?? null;
      },

      async list(options: { limit?: number } = {}) {
        return tx
          .select()
          .from(documents)
          .where(and(eq(documents.spaceId, ctx.spaceId), isNull(documents.deletedAt)))
          .orderBy(desc(documents.createdAt))
          .limit(Math.min(options.limit ?? 50, 200));
      },

      /**
       * Free text over name + OCR output, plus tag filters. `plainto_tsquery`
       * rather than `to_tsquery` so a user typing `MRI כתף` gets a search instead of a
       * syntax error.
       *
       * Several tags narrow rather than widen — a document must carry *all* of them. Tags
       * come off an extraction that invents them freely, so a space has many and each one
       * matches a lot; "מעבדה and לב" is the question someone actually has, and OR would
       * only ever hand back more than they started with.
       */
      async search(input: {
        text?: string;
        tags?: readonly string[];
        sort?: DocumentSort;
        limit?: number;
      }) {
        const conditions = [eq(documents.spaceId, ctx.spaceId), isNull(documents.deletedAt)];

        if (input.text?.trim()) {
          conditions.push(
            sql`to_tsvector('simple', coalesce(${documents.name}, '') || ' ' || coalesce(${documents.extractedText}, ''))
                @@ plainto_tsquery('simple', ${input.text.trim()})`,
          );
        }

        // Bounded because each tag is another correlated subquery and the list arrives from
        // a URL anyone can lengthen. Eight is far past what the filter panel can produce by
        // clicking; the extras are dropped, and the page says so when it happens.
        for (const tag of [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TAG_FILTERS)) {
          conditions.push(
            sql`exists (
              select 1 from document_tags dt
              join tags t on t.id = dt.tag_id
              where dt.document_id = ${documents.id}
                and dt.space_id = ${ctx.spaceId}::uuid
                and t.name = ${tag}
            )`,
          );
        }

        return tx
          .select()
          .from(documents)
          .where(and(...conditions))
          .orderBy(...documentOrder(input.sort ?? 'added'))
          .limit(Math.min(input.limit ?? 50, 200));
      },

      /**
       * Documents whose own date falls in a window, for the month view.
       *
       * `doc_date` is a plain civil date with no instant behind it — "the 19th of July" is
       * the same day in every timezone — so this is a string comparison and, unlike the
       * events query, no timezone is involved at all.
       *
       * Partial dates are excluded on purpose. The column is text precisely because
       * extraction is often partial (§6), and `2026-07` cannot be placed on a day. A row
       * that cannot be drawn is better left out of the query than fetched and silently
       * dropped by the grid.
       */
      async inDateRange(input: { from: string; to: string; limit?: number }) {
        return tx
          .select({
            id: documents.id,
            name: documents.name,
            docDate: documents.docDate,
            docType: documents.docType,
          })
          .from(documents)
          .where(
            and(
              eq(documents.spaceId, ctx.spaceId),
              isNull(documents.deletedAt),
              sql`length(${documents.docDate}) = 10`,
              gte(documents.docDate, input.from),
              lte(documents.docDate, input.to),
            ),
          )
          .orderBy(asc(documents.docDate))
          .limit(Math.min(input.limit ?? 500, 1000));
      },

      /**
       * Documents whose date got as far as a month and no further — `2026-08`.
       *
       * The equality is exact and that is what makes it correct: a full date is ten
       * characters, so matching a seven-character month can only return the partial ones.
       * A date of just `2026` does not match either, which is right — it belongs to a year,
       * not to this month.
       *
       * Documents with *no* date are deliberately not here. They belong to no month at all,
       * and putting them under one would be the app inventing a fact about a medical record.
       */
      async datedToMonth(input: { month: string; limit?: number }) {
        return tx
          .select({ id: documents.id, name: documents.name, docType: documents.docType })
          .from(documents)
          .where(
            and(
              eq(documents.spaceId, ctx.spaceId),
              isNull(documents.deletedAt),
              eq(documents.docDate, input.month),
            ),
          )
          .orderBy(desc(documents.createdAt))
          .limit(Math.min(input.limit ?? 100, 200));
      },

      /**
       * Optimistic locking (DESIGN.md §3.6), exactly as `events.update` does it: the update
       * asserts the version the caller read, so two members correcting the same document
       * produce a conflict rather than one silently overwriting the other.
       *
       * `extractedText` is absent from the input on purpose and not by oversight. It is what
       * the *document* says, not what a person decided it says — the search index is supposed
       * to reflect the record, so letting a corrected doctor name rewrite the text the search
       * runs over would make the index disagree with the file it points at. Correcting
       * metadata and re-reading the document are different acts; only the first is here.
       *
       * The `isNull(deletedAt)` guard matters: `softDelete` does not version-check, so
       * without it an edit could resurrect a document someone deleted a moment earlier.
       */
      async update(
        id: string,
        expectedVersion: number,
        input: {
          name?: string;
          docType?: string | null;
          docDate?: string | null;
          hospital?: string | null;
          doctor?: string | null;
          actionRequired?: boolean;
        },
      ) {
        const [row] = await tx
          .update(documents)
          .set({ ...input, version: expectedVersion + 1, updatedAt: new Date() })
          .where(
            and(
              eq(documents.spaceId, ctx.spaceId),
              eq(documents.id, id),
              eq(documents.version, expectedVersion),
              isNull(documents.deletedAt),
            ),
          )
          .returning();
        return row ?? null;
      },

      async softDelete(id: string) {
        const [row] = await tx
          .update(documents)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(documents.spaceId, ctx.spaceId), eq(documents.id, id)))
          .returning();
        return row ?? null;
      },

      /**
       * Documents flagged as needing something done that no action item covers — the
       * backlog left by any document saved before M2 existed to listen for it.
       *
       * The `not exists` deliberately ignores the item's status, so a proposal the user
       * dismissed is not resurrected on the next run.
       */
      async actionRequiredWithoutItem(options: { limit?: number } = {}) {
        return tx
          .select({
            id: documents.id,
            name: documents.name,
            docDate: documents.docDate,
            extractionRaw: documents.extractionRaw,
          })
          .from(documents)
          .where(
            and(
              eq(documents.spaceId, ctx.spaceId),
              eq(documents.actionRequired, true),
              isNull(documents.deletedAt),
              sql`not exists (
                select 1 from action_items ai
                where ai.space_id = ${ctx.spaceId}::uuid
                  and ai.source = 'document'
                  and ai.source_id = ${documents.id}
              )`,
            ),
          )
          .orderBy(desc(documents.createdAt))
          .limit(Math.min(options.limit ?? 500, 1000));
      },
    },

    tags: {
      async list() {
        return tx.select().from(tags).where(eq(tags.spaceId, ctx.spaceId)).orderBy(tags.name);
      },

      /**
       * The tags with something behind them, commonest first — the vocabulary as a filter,
       * rather than as a list.
       *
       * It counts documents rather than reading the `tags` table because the two disagree in
       * one case that matters: a soft-deleted document keeps its links, so `list()` still
       * offers a tag whose only document is gone, and clicking it would return nothing with
       * no way to tell an empty result from a broken filter. Joining through to living
       * documents means a tag is offered exactly when it has something to show.
       *
       * Ordered by count and then by name: extraction invents tags freely, so a space
       * accumulates dozens, and alphabetical order buries the handful anyone filters by
       * under the one-offs.
       */
      async inUse(options: { limit?: number } = {}) {
        return tx
          .select({ name: tags.name, count: sql<number>`count(*)::int` })
          .from(tags)
          .innerJoin(
            documentTags,
            and(eq(documentTags.tagId, tags.id), eq(documentTags.spaceId, ctx.spaceId)),
          )
          .innerJoin(
            documents,
            and(
              eq(documents.id, documentTags.documentId),
              eq(documents.spaceId, ctx.spaceId),
              isNull(documents.deletedAt),
            ),
          )
          .where(eq(tags.spaceId, ctx.spaceId))
          .groupBy(tags.name)
          .orderBy(desc(sql`count(*)`), asc(tags.name))
          .limit(Math.min(options.limit ?? 100, 300));
      },

      /** Idempotent: tag names are unique per space, so re-adding is a no-op. */
      attach: attachTags,

      async forDocument(documentId: string) {
        return tx
          .select({ id: tags.id, name: tags.name })
          .from(documentTags)
          .innerJoin(tags, eq(tags.id, documentTags.tagId))
          .where(and(eq(documentTags.spaceId, ctx.spaceId), eq(documentTags.documentId, documentId)));
      },

      /**
       * The set of tags a document has, made to equal `names`.
       *
       * `attach` alone cannot express an edit: it is additive, so a user removing a wrong tag
       * would watch it come straight back. This detaches what is gone, attaches what is new,
       * and leaves the rest untouched.
       *
       * It then deletes vocabulary rows nothing points at any more. Extraction invents tags,
       * so without this a typo the user has just corrected survives forever in the tag filter
       * as an entry that matches no documents. The delete is scoped to the space and guarded
       * on the tag having no remaining links *anywhere* in it, so a tag another document still
       * uses is never removed.
       */
      async replaceForDocument(documentId: string, names: readonly string[]) {
        const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

        const current = await tx
          .select({ id: tags.id, name: tags.name })
          .from(documentTags)
          .innerJoin(tags, eq(tags.id, documentTags.tagId))
          .where(and(eq(documentTags.spaceId, ctx.spaceId), eq(documentTags.documentId, documentId)));

        const removed = current.filter((tag) => !wanted.includes(tag.name));
        if (removed.length > 0) {
          const removedIds = removed.map((tag) => tag.id);

          await tx.delete(documentTags).where(
            and(
              eq(documentTags.spaceId, ctx.spaceId),
              eq(documentTags.documentId, documentId),
              inArray(documentTags.tagId, removedIds),
            ),
          );

          // The `not exists` is the actual guard, and it runs after the detach above: a tag
          // another document still uses simply matches nothing here and survives.
          await tx.delete(tags).where(
            and(
              eq(tags.spaceId, ctx.spaceId),
              inArray(tags.id, removedIds),
              sql`not exists (
                select 1 from document_tags dt
                where dt.tag_id = ${tags.id} and dt.space_id = ${ctx.spaceId}::uuid
              )`,
            ),
          );
        }

        const added = wanted.filter((name) => !current.some((tag) => tag.name === name));
        if (added.length > 0) await attachTags(documentId, added);

        return wanted;
      },
    },

    events: {
      async create(input: {
        kind: 'appointment' | 'reminder' | 'task';
        title: string;
        notes?: string | null;
        startsAt: Date;
        endsAt?: Date | null;
        allDay?: boolean;
        location?: string | null;
        sourceDocumentId?: string | null;
      }) {
        const [row] = await tx
          .insert(events)
          .values({
            spaceId: ctx.spaceId,
            createdBy: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
          })
          .returning();
        return row;
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(events)
          .where(and(eq(events.spaceId, ctx.spaceId), eq(events.id, id)))
          .limit(1);
        return row ?? null;
      },

      /** Chronological rather than newest-first: an agenda reads forwards. */
      async upcoming(options: { from?: Date; limit?: number } = {}) {
        return tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.spaceId, ctx.spaceId),
              eq(events.status, 'scheduled'),
              gte(events.startsAt, options.from ?? new Date()),
            ),
          )
          .orderBy(asc(events.startsAt))
          .limit(Math.min(options.limit ?? 50, 200));
      },

      /**
       * Everything that lands in a window, for the month view.
       *
       * Unlike the agenda this includes what already happened — a calendar of a month is
       * a record as much as a plan, and an appointment that was attended is exactly what
       * someone scrolling back is looking for. Cancelled entries are the one exclusion:
       * they are not happening, and a grid is too small to explain the difference.
       */
      async inRange(input: { from: Date; to: Date; limit?: number }) {
        return tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.spaceId, ctx.spaceId),
              ne(events.status, 'cancelled'),
              gte(events.startsAt, input.from),
              lt(events.startsAt, input.to),
            ),
          )
          .orderBy(asc(events.startsAt))
          .limit(Math.min(input.limit ?? 500, 1000));
      },

      /** Everything still needing attention: upcoming, plus anything already overdue. */
      async openAndOverdue(options: { limit?: number } = {}) {
        return tx
          .select()
          .from(events)
          .where(and(eq(events.spaceId, ctx.spaceId), eq(events.status, 'scheduled')))
          .orderBy(asc(events.startsAt))
          .limit(Math.min(options.limit ?? 50, 200));
      },

      /**
       * Optimistic locking (DESIGN.md §3.6): the update asserts the version the caller
       * read, so two members editing the same appointment produce a conflict rather than
       * one silently overwriting the other.
       */
      async update(
        id: string,
        expectedVersion: number,
        input: {
          title?: string;
          notes?: string | null;
          startsAt?: Date;
          endsAt?: Date | null;
          allDay?: boolean;
          location?: string | null;
          status?: 'scheduled' | 'done' | 'cancelled';
        },
      ) {
        const [row] = await tx
          .update(events)
          .set({ ...input, version: expectedVersion + 1, updatedAt: new Date() })
          .where(
            and(
              eq(events.spaceId, ctx.spaceId),
              eq(events.id, id),
              eq(events.version, expectedVersion),
            ),
          )
          .returning();
        return row ?? null;
      },

      /**
       * Sync bookkeeping, deliberately not version-checked: it records what Google did
       * with a row, not what a person decided, so it must never lose a race to a
       * concurrent edit.
       */
      async recordSync(
        id: string,
        input: { externalCalendarRef?: string | null; calendarSyncStatus: 'pending' | 'synced' | 'failed' },
      ) {
        const [row] = await tx
          .update(events)
          .set(input)
          .where(and(eq(events.spaceId, ctx.spaceId), eq(events.id, id)))
          .returning();
        return row ?? null;
      },
    },

    actionItems: {
      async create(input: {
        source: 'document' | 'correspondence' | 'visit';
        sourceId?: string | null;
        title: string;
        dueAt?: Date | null;
      }) {
        const [row] = await tx
          .insert(actionItems)
          .values({
            spaceId: ctx.spaceId,
            createdBy: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
          })
          .returning();
        return row;
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(actionItems)
          .where(and(eq(actionItems.spaceId, ctx.spaceId), eq(actionItems.id, id)))
          .limit(1);
        return row ?? null;
      },

      /**
       * Left-joined to `documents` so a proposal can say which document it came out of.
       *
       * The join condition carries `source = 'document'` because `source_id` is
       * polymorphic and therefore has no foreign key: joining on the id alone would be
       * asking the database to match a correspondence id against a document id, which is
       * meaningless rather than merely empty. A document that has since been deleted (or
       * soft-deleted — hence the `deleted_at` test) yields a null name and date, and the
       * screen falls back to the label it always had. The proposal itself survives either
       * way: its `title` was denormalized at creation for exactly this reason.
       */
      async list(options: { status?: ActionItemStatus[]; limit?: number } = {}) {
        const conditions = [eq(actionItems.spaceId, ctx.spaceId)];
        if (options.status?.length) conditions.push(inArray(actionItems.status, options.status));

        return tx
          .select({
            id: actionItems.id,
            source: actionItems.source,
            sourceId: actionItems.sourceId,
            title: actionItems.title,
            dueAt: actionItems.dueAt,
            status: actionItems.status,
            eventId: actionItems.eventId,
            // Null for a proposal the app made, which is how `verify:agenda` tells an
            // extracted suggestion from one a member typed (DESIGN.md §7.2).
            createdBy: actionItems.createdBy,
            createdAt: actionItems.createdAt,
            updatedAt: actionItems.updatedAt,
            sourceDocumentName: documents.name,
            // The document's own date, not `created_at`: a letter scanned today can be
            // three months old, and which one it is changes how urgent the proposal reads.
            sourceDocumentDate: documents.docDate,
          })
          .from(actionItems)
          .leftJoin(
            documents,
            and(
              eq(actionItems.source, 'document'),
              eq(documents.id, actionItems.sourceId),
              eq(documents.spaceId, ctx.spaceId),
              isNull(documents.deletedAt),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(actionItems.createdAt))
          .limit(Math.min(options.limit ?? 50, 200));
      },

      /** Guards against a second click resolving an item someone already resolved. */
      async resolve(
        id: string,
        input: { status: Exclude<ActionItemStatus, 'proposed'>; eventId?: string | null },
      ) {
        const [row] = await tx
          .update(actionItems)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(actionItems.spaceId, ctx.spaceId),
              eq(actionItems.id, id),
              eq(actionItems.status, 'proposed'),
            ),
          )
          .returning();
        return row ?? null;
      },

      /**
       * One proposal per source. Extraction re-runs and retries would otherwise stack up
       * duplicate suggestions for the same document.
       */
      async existsForSource(source: 'document' | 'correspondence' | 'visit', sourceId: string) {
        const [row] = await tx
          .select({ id: actionItems.id })
          .from(actionItems)
          .where(
            and(
              eq(actionItems.spaceId, ctx.spaceId),
              eq(actionItems.source, source),
              eq(actionItems.sourceId, sourceId),
            ),
          )
          .limit(1);
        return Boolean(row);
      },
    },

    contacts: {
      async list(options: { kind?: 'doctor' | 'clinic' | 'hmo' } = {}) {
        const conditions = [eq(contacts.spaceId, ctx.spaceId)];
        if (options.kind) conditions.push(eq(contacts.kind, options.kind));
        return tx.select().from(contacts).where(and(...conditions)).orderBy(contacts.name);
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.spaceId, ctx.spaceId), eq(contacts.id, id)))
          .limit(1);
        return row ?? null;
      },

      /**
       * Idempotent on (kind, name), because the backfill reads the same doctor's name off
       * every letter they ever signed. A second sighting fills in details the first one
       * lacked but never blanks what is already there — `coalesce(excluded, existing)`
       * rather than a plain overwrite, so re-running the backfill cannot erase an email
       * somebody typed by hand.
       */
      async upsert(input: {
        kind: 'doctor' | 'clinic' | 'hmo';
        name: string;
        specialty?: string | null;
        phone?: string | null;
        email?: string | null;
        notes?: string | null;
      }) {
        const name = input.name.trim();
        if (!name) return null;

        const [row] = await tx
          .insert(contacts)
          .values({
            spaceId: ctx.spaceId,
            createdBy: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
            name,
          })
          .onConflictDoUpdate({
            target: [contacts.spaceId, contacts.kind, contacts.name],
            set: {
              specialty: sql`coalesce(excluded.specialty, ${contacts.specialty})`,
              phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
              email: sql`coalesce(excluded.email, ${contacts.email})`,
              notes: sql`coalesce(excluded.notes, ${contacts.notes})`,
              updatedAt: new Date(),
            },
          })
          .returning();
        return row;
      },

      async update(id: string, input: { email?: string | null; phone?: string | null; specialty?: string | null; notes?: string | null }) {
        const [row] = await tx
          .update(contacts)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(contacts.spaceId, ctx.spaceId), eq(contacts.id, id)))
          .returning();
        return row ?? null;
      },

      /** Distinct doctor and hospital names extraction has already written onto documents. */
      async namesFromDocuments() {
        return tx
          .select({ doctor: documents.doctor, hospital: documents.hospital })
          .from(documents)
          .where(and(eq(documents.spaceId, ctx.spaceId), isNull(documents.deletedAt)));
      },
    },

    correspondence: {
      async create(input: {
        flowType: 'prescription_conversion' | 'commitment_form' | 'general_inquiry';
        contactId?: string | null;
        recipientEmail?: string | null;
        subject: string;
        body: string;
      }) {
        const [row] = await tx
          .insert(correspondence)
          .values({
            spaceId: ctx.spaceId,
            createdBy: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
          })
          .returning();
        return row;
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(correspondence)
          .where(and(eq(correspondence.spaceId, ctx.spaceId), eq(correspondence.id, id)))
          .limit(1);
        return row ?? null;
      },

      async list(options: { status?: Array<'draft' | 'sent' | 'awaiting_reply' | 'done' | 'cancelled'>; limit?: number } = {}) {
        const conditions = [eq(correspondence.spaceId, ctx.spaceId)];
        if (options.status?.length) conditions.push(inArray(correspondence.status, options.status));

        return tx
          .select({
            id: correspondence.id,
            flowType: correspondence.flowType,
            status: correspondence.status,
            subject: correspondence.subject,
            recipientEmail: correspondence.recipientEmail,
            contactName: contacts.name,
            sentAt: correspondence.sentAt,
            sentByName: users.name,
            createdAt: correspondence.createdAt,
            version: correspondence.version,
          })
          .from(correspondence)
          .leftJoin(contacts, eq(contacts.id, correspondence.contactId))
          .leftJoin(users, eq(users.id, correspondence.sentByUserId))
          .where(and(...conditions))
          .orderBy(desc(correspondence.createdAt))
          .limit(Math.min(options.limit ?? 50, 200));
      },

      /**
       * Optimistic locking, as for events (DESIGN.md §3.6). Editing a draft two members are
       * both looking at is exactly the shared-caregiving case this app exists for.
       */
      async updateDraft(
        id: string,
        expectedVersion: number,
        input: { subject?: string; body?: string; contactId?: string | null; recipientEmail?: string | null },
      ) {
        const [row] = await tx
          .update(correspondence)
          .set({ ...input, version: expectedVersion + 1, updatedAt: new Date() })
          .where(
            and(
              eq(correspondence.spaceId, ctx.spaceId),
              eq(correspondence.id, id),
              eq(correspondence.version, expectedVersion),
              // Only a draft is editable. Once it has gone to the kupah, the record of what
              // was actually sent must not be rewritten.
              eq(correspondence.status, 'draft'),
            ),
          )
          .returning();
        return row ?? null;
      },

      /**
       * Claims a draft for sending, conditionally.
       *
       * The condition is the whole point: two members pressing send at the same moment both
       * run this, and only one update matches a row that is still `draft`. The loser gets
       * null and stops, so a clerk receives one request rather than two identical ones.
       *
       * Returning null therefore means "somebody else got there", not "no such row".
       */
      async markSent(id: string, input: { recipientEmail: string; sentByUserId: string | null }) {
        const [row] = await tx
          .update(correspondence)
          .set({
            status: 'awaiting_reply',
            sentAt: new Date(),
            updatedAt: new Date(),
            ...input,
          })
          .where(
            and(
              eq(correspondence.spaceId, ctx.spaceId),
              eq(correspondence.id, id),
              eq(correspondence.status, 'draft'),
            ),
          )
          .returning();
        return row ?? null;
      },

      /** The provider's ids, once the message is actually gone. */
      async recordDelivery(id: string, input: { messageRef: string; threadRef: string }) {
        const [row] = await tx
          .update(correspondence)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(correspondence.spaceId, ctx.spaceId), eq(correspondence.id, id)))
          .returning();
        return row ?? null;
      },

      /**
       * Undoes a claim whose send then failed, so the draft is editable and re-sendable
       * rather than stuck looking like a request nobody answered.
       *
       * Guarded on `message_ref is null`: if delivery did in fact happen, this must not
       * turn a sent request back into a draft that someone sends a second time.
       */
      async releaseClaim(id: string) {
        const [row] = await tx
          .update(correspondence)
          .set({ status: 'draft', sentAt: null, sentByUserId: null, updatedAt: new Date() })
          .where(
            and(
              eq(correspondence.spaceId, ctx.spaceId),
              eq(correspondence.id, id),
              eq(correspondence.status, 'awaiting_reply'),
              isNull(correspondence.messageRef),
            ),
          )
          .returning();
        return row ?? null;
      },

      async setStatus(id: string, status: 'awaiting_reply' | 'done' | 'cancelled') {
        const [row] = await tx
          .update(correspondence)
          .set({ status, updatedAt: new Date() })
          .where(and(eq(correspondence.spaceId, ctx.spaceId), eq(correspondence.id, id)))
          .returning();
        return row ?? null;
      },

      async attach(correspondenceId: string, documentIds: readonly string[]) {
        const ids = [...new Set(documentIds)].filter(Boolean);
        if (ids.length === 0) return [];

        // The ids are resolved against this space first, so anything belonging to another
        // space is silently dropped rather than attached. RLS would refuse to *read* such a
        // document later, but the attachment row itself would insert happily — this is an
        // outgoing email, and the moment to decide what may ride on it is now.
        const permitted = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.spaceId, ctx.spaceId),
              isNull(documents.deletedAt),
              inArray(documents.id, ids),
            ),
          );
        if (permitted.length === 0) return [];

        return tx
          .insert(correspondenceAttachments)
          .values(
            permitted.map((document) => ({
              correspondenceId,
              documentId: document.id,
              spaceId: ctx.spaceId,
            })),
          )
          .onConflictDoNothing()
          .returning();
      },

      async attachments(correspondenceId: string) {
        return tx
          .select({
            id: documents.id,
            name: documents.name,
            mimeType: documents.mimeType,
            storageRef: documents.storageRef,
            storageProvider: documents.storageProvider,
          })
          .from(correspondenceAttachments)
          .innerJoin(documents, eq(documents.id, correspondenceAttachments.documentId))
          .where(
            and(
              eq(correspondenceAttachments.spaceId, ctx.spaceId),
              eq(correspondenceAttachments.correspondenceId, correspondenceId),
            ),
          );
      },
    },

    questions: {
      async create(input: { text: string; eventId?: string | null; contactId?: string | null }) {
        const [row] = await tx
          .insert(questions)
          .values({
            spaceId: ctx.spaceId,
            createdBy: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
          })
          .returning();
        return row;
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(questions)
          .where(and(eq(questions.spaceId, ctx.spaceId), eq(questions.id, id)))
          .limit(1);
        return row ?? null;
      },

      /**
       * Joined to `users` because at the visit it matters *who* asked for this to be
       * raised — a question from the sibling who could not come is the whole reason this
       * table is shared (DESIGN.md §5, M4).
       *
       * Unasked first, then oldest first: in a consulting room the list is read top to
       * bottom under time pressure, so the things still outstanding belong at the top.
       */
      async list(options: { eventId?: string | null; includeAsked?: boolean } = {}) {
        const conditions = [eq(questions.spaceId, ctx.spaceId)];
        if (options.eventId !== undefined) {
          conditions.push(
            options.eventId === null ? isNull(questions.eventId) : eq(questions.eventId, options.eventId),
          );
        }
        if (!options.includeAsked) conditions.push(eq(questions.asked, false));

        return tx
          .select({
            id: questions.id,
            eventId: questions.eventId,
            text: questions.text,
            asked: questions.asked,
            answerSummary: questions.answerSummary,
            createdAt: questions.createdAt,
            askedByName: users.name,
          })
          .from(questions)
          .leftJoin(users, eq(users.id, questions.createdBy))
          .where(and(...conditions))
          .orderBy(questions.asked, questions.createdAt);
      },

      /** How many are still outstanding per appointment, for the agenda to show. */
      async openCountsByEvent() {
        return tx
          .select({ eventId: questions.eventId, open: sql<number>`count(*)::int` })
          .from(questions)
          .where(and(eq(questions.spaceId, ctx.spaceId), eq(questions.asked, false), sql`${questions.eventId} is not null`))
          .groupBy(questions.eventId);
      },

      async update(
        id: string,
        input: { text?: string; asked?: boolean; answerSummary?: string | null; eventId?: string | null },
      ) {
        const [row] = await tx
          .update(questions)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(questions.spaceId, ctx.spaceId), eq(questions.id, id)))
          .returning();
        return row ?? null;
      },

      async remove(id: string) {
        const [row] = await tx
          .delete(questions)
          .where(and(eq(questions.spaceId, ctx.spaceId), eq(questions.id, id)))
          .returning();
        return row ?? null;
      },
    },

    visits: {
      /**
       * The event id is resolved against this space before it is stored, so a tampered
       * request cannot file a recording of one family's consultation against another
       * family's appointment.
       */
      async create(input: {
        eventId?: string | null;
        recordingRef: string;
        recordingProvider: 'google-drive' | 's3' | 'vercel-blob' | 'local';
        recordingMimeType: string;
        recordingDurationMs?: number | null;
        recordingBytes?: number | null;
      }) {
        let eventId: string | null = null;
        if (input.eventId) {
          const [event] = await tx
            .select({ id: events.id })
            .from(events)
            .where(and(eq(events.spaceId, ctx.spaceId), eq(events.id, input.eventId)))
            .limit(1);
          eventId = event?.id ?? null;
        }

        const [row] = await tx
          .insert(visits)
          .values({
            spaceId: ctx.spaceId,
            recordedByUserId: isSystemContext(ctx) ? null : ctx.userId,
            ...input,
            eventId,
          })
          .returning();
        return row;
      },

      async get(id: string) {
        const [row] = await tx
          .select()
          .from(visits)
          .where(and(eq(visits.spaceId, ctx.spaceId), eq(visits.id, id)))
          .limit(1);
        return row ?? null;
      },

      async listForEvent(eventId: string) {
        return tx
          .select({
            id: visits.id,
            recordingMimeType: visits.recordingMimeType,
            recordingDurationMs: visits.recordingDurationMs,
            recordingBytes: visits.recordingBytes,
            recordedAt: visits.recordedAt,
            recordedByName: users.name,
            // Both stay null until a transcription provider is chosen (DESIGN.md §12);
            // the screen reads them so it can say so rather than imply otherwise.
            transcriptRef: visits.transcriptRef,
            summaryDocId: visits.summaryDocId,
          })
          .from(visits)
          .leftJoin(users, eq(users.id, visits.recordedByUserId))
          .where(and(eq(visits.spaceId, ctx.spaceId), eq(visits.eventId, eventId)))
          .orderBy(desc(visits.recordedAt));
      },

      async remove(id: string) {
        const [row] = await tx
          .delete(visits)
          .where(and(eq(visits.spaceId, ctx.spaceId), eq(visits.id, id)))
          .returning();
        return row ?? null;
      },
    },

    /**
     * Read-only by design. Activity rows are written by the unit of work, never by a
     * feature module — see DESIGN.md §7.2.
     */
    activity: {
      /**
       * Left-joined to `users` so the feed can say *who*. "דנה העלתה מסמך" is the entire
       * value of this table in a shared space; "someone uploaded a document" is not worth
       * a screen. The join is a LEFT one because `actor_user_id` is null for system
       * actions and for a user who has since been deleted, and both must still appear —
       * a gap in the timeline reads as data loss (DESIGN.md §7.2).
       */
      async feed(options: { limit?: number; before?: Date } = {}) {
        const limit = Math.min(options.limit ?? 50, 200);
        const where = options.before
          ? and(eq(activityLog.spaceId, ctx.spaceId), lt(activityLog.createdAt, options.before))
          : eq(activityLog.spaceId, ctx.spaceId);
        return tx
          .select({
            id: activityLog.id,
            actorType: activityLog.actorType,
            actorName: users.name,
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            summary: activityLog.summary,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .leftJoin(users, eq(users.id, activityLog.actorUserId))
          .where(where)
          .orderBy(desc(activityLog.createdAt))
          .limit(limit);
      },

      async forEntity(entityType: string, entityId: string) {
        return tx
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.spaceId, ctx.spaceId),
              eq(activityLog.entityType, entityType),
              eq(activityLog.entityId, entityId),
            ),
          )
          .orderBy(desc(activityLog.createdAt));
      },
    },

    /**
     * The persisted application log, read-only.
     *
     * Written by `core/logging/persist.ts` and by nothing else — the same split as
     * `activity`, and for a stronger reason: the application role has no UPDATE or DELETE
     * grant on this table, so a method that tried to amend a row would fail at the
     * database rather than in review.
     *
     * Every query here is restricted to `model is not null`, which is what "an AI call"
     * means in this table. Warnings and errors share the table (they are the other thing
     * worth keeping after the process exits) and are simply not what this screen is about.
     *
     * Days are Israeli days. A call at 00:30 belongs to the day the person who made it
     * would say it belongs to, not to the UTC day the function happened to run in — the
     * same rule the calendar enforces in `app/calendar/month.ts`.
     */
    usage: {
      async totals(input: { since?: Date } = {}) {
        const [row] = await tx
          .select({
            calls: sql<number>`count(*)::int`,
            tokensIn: sql<string>`coalesce(sum(${appLog.tokensIn}), 0)::bigint`,
            tokensOut: sql<string>`coalesce(sum(${appLog.tokensOut}), 0)::bigint`,
            costUsd: sql<number>`coalesce(sum(${appLog.costUsd}), 0)::float8`,
            /** Calls whose model had no price in the table — the screen says so. */
            unpriced: sql<number>`count(*) filter (where ${appLog.costUsd} is null)::int`,
          })
          .from(appLog)
          .where(and(...usageConditions(input.since)));
        return row;
      },

      /** Spend split by what the call was *for*: extraction, text extraction, completion. */
      async byOperation(input: { since?: Date } = {}) {
        return tx
          .select({
            operation: appLog.operation,
            model: appLog.model,
            calls: sql<number>`count(*)::int`,
            tokensIn: sql<string>`coalesce(sum(${appLog.tokensIn}), 0)::bigint`,
            tokensOut: sql<string>`coalesce(sum(${appLog.tokensOut}), 0)::bigint`,
            costUsd: sql<number>`coalesce(sum(${appLog.costUsd}), 0)::float8`,
          })
          .from(appLog)
          .where(and(...usageConditions(input.since)))
          .groupBy(appLog.operation, appLog.model)
          .orderBy(sql`coalesce(sum(${appLog.costUsd}), 0) desc`);
      },

      async byDay(input: { since?: Date } = {}) {
        return tx
          .select({
            day: sql<string>`to_char(${appLog.createdAt} at time zone 'Asia/Jerusalem', 'YYYY-MM-DD')`,
            calls: sql<number>`count(*)::int`,
            costUsd: sql<number>`coalesce(sum(${appLog.costUsd}), 0)::float8`,
          })
          .from(appLog)
          .where(and(...usageConditions(input.since)))
          .groupBy(sql`1`)
          .orderBy(sql`1 desc`);
      },

      /** The last few calls, so a number on the screen can be traced to a moment. */
      async recent(input: { limit?: number } = {}) {
        return tx
          .select({
            id: appLog.id,
            createdAt: appLog.createdAt,
            operation: appLog.operation,
            model: appLog.model,
            tokensIn: appLog.tokensIn,
            tokensOut: appLog.tokensOut,
            costUsd: appLog.costUsd,
            durationMs: appLog.durationMs,
            userName: users.name,
          })
          .from(appLog)
          .leftJoin(users, eq(users.id, appLog.userId))
          .where(and(...usageConditions()))
          .orderBy(desc(appLog.createdAt))
          .limit(Math.min(input.limit ?? 20, 100));
      },
    },

    /** Escape hatch for raw SQL that still wants the space predicate applied by hand. */
    get spaceId() {
      return sql`${ctx.spaceId}::uuid`;
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

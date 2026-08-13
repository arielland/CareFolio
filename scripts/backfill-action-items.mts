import { randomUUID } from 'node:crypto';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { listSpacesForUser } from '@/core/db/bootstrap';
import { systemContext } from '@/core/context/space-context';
import { backfillProposalsFromDocuments } from '@/modules/calendar';

/**
 * One-off: propose action items for documents scanned before M2 existed to hear about
 * them (DESIGN.md §9, phases 1 → 2).
 *
 * Safe to run more than once — the backfill skips any document that already has an item,
 * including one the user dismissed. It reads text already stored in `extraction_raw`, so
 * it costs no LLM calls and re-extracts nothing.
 *
 * Spaces are enumerated by walking users and asking `app_spaces_for_user`, the same
 * security-definer path the app itself uses, rather than by reaching for the table owner's
 * credential to read past row-level security. A maintenance task is not a reason to step
 * outside the tenancy model.
 *
 * Run with: npm run backfill:actions
 */
async function main() {
  const everyone = await db.select({ id: users.id }).from(users);

  const seen = new Set<string>();
  const totals = { spaces: 0, candidates: 0, proposed: 0, skipped: 0 };

  for (const user of everyone) {
    for (const membership of await listSpacesForUser(user.id)) {
      if (seen.has(membership.spaceId)) continue; // shared spaces surface once per member
      seen.add(membership.spaceId);

      // No human is asking for these proposals, so the actor is the app itself.
      const ctx = systemContext(membership.spaceId, randomUUID());
      const report = await backfillProposalsFromDocuments(ctx);

      totals.spaces++;
      totals.candidates += report.candidates;
      totals.proposed += report.proposed;
      totals.skipped += report.skippedWithoutSummary;

      if (report.candidates > 0) {
        console.log(
          `space ${membership.spaceId}: ${report.candidates} flagged, ` +
            `${report.proposed} proposed, ${report.skippedWithoutSummary} without an action summary`,
        );
      }
    }
  }

  console.log(
    `\n${totals.spaces} space(s) scanned — ${totals.candidates} document(s) flagged, ` +
      `${totals.proposed} proposal(s) created, ${totals.skipped} skipped.`,
  );
  if (totals.skipped > 0) {
    console.log(
      'Skipped documents are flagged as needing action but never recorded what. ' +
        'They stay visible as "נדרשת פעולה" on the document list.',
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

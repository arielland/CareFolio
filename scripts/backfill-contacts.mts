import { randomUUID } from 'node:crypto';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { listSpacesForUser } from '@/core/db/bootstrap';
import { systemContext } from '@/core/context/space-context';
import { backfillContactsFromDocuments } from '@/modules/hmo-comms';

/**
 * One-off: create contacts from the doctor and hospital names extraction has been writing
 * onto documents since Phase 1.
 *
 * DESIGN.md §6 deferred the contacts table on the grounds that nothing populated it and it
 * would be an empty column pointing at an empty table. This is the backfill that decision
 * promised, arriving with M3 exactly as described — correspondence has to be addressed to
 * somebody, and every letter already names one.
 *
 * Safe to run more than once. `contacts.upsert` is keyed on (kind, name) and fills blanks
 * with `coalesce` rather than overwriting, so an email address somebody typed in by hand
 * survives every later run. What it cannot do is merge "ד״ר לוי" with "דר' לוי" — the same
 * person spelled two ways is two contacts, and a person is better placed to notice that
 * than a script guessing at Hebrew abbreviations.
 *
 * Spaces are enumerated by walking users and asking `app_spaces_for_user`, the same
 * security-definer path the app itself uses, rather than reaching for the table owner's
 * credential to read past row-level security.
 *
 * Run with: npm run backfill:contacts
 */
async function main() {
  const everyone = await db.select({ id: users.id }).from(users);

  const seen = new Set<string>();
  const totals = { spaces: 0, doctors: 0, clinics: 0 };

  for (const user of everyone) {
    for (const membership of await listSpacesForUser(user.id)) {
      if (seen.has(membership.spaceId)) continue; // shared spaces surface once per member
      seen.add(membership.spaceId);

      // Nobody asked for these rows; the app inferred them from documents it already had.
      const ctx = systemContext(membership.spaceId, randomUUID());
      const report = await backfillContactsFromDocuments(ctx);

      totals.spaces++;
      totals.doctors += report.doctors;
      totals.clinics += report.clinics;

      if (report.doctors + report.clinics > 0) {
        console.log(`space ${membership.spaceId}: ${report.doctors} doctor(s), ${report.clinics} clinic(s)`);
      }
    }
  }

  console.log(
    `\n${totals.spaces} space(s) scanned — ${totals.doctors} doctor(s) and ${totals.clinics} clinic(s) recorded.`,
  );
  console.log('Email addresses are not in the documents; add them on the contact before writing to one.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

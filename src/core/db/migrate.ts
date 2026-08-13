import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

/**
 * Runs schema migrations, then applies the RLS policies and grants.
 *
 * Connects as the owning role. On Supabase that is `POSTGRES_URL_NON_POOLING`, which
 * the marketplace integration provisions — so the owner credential never needs storing
 * separately, and DATABASE_MIGRATION_URL is only for a self-hosted Postgres.
 *
 * Deliberately does NOT fall back to DATABASE_URL: that points at the non-owner
 * `healthapp_app` role, which cannot create tables, and a confusing permissions error
 * is worse than saying so outright.
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.POSTGRES_URL_NON_POOLING;
  if (!url) {
    throw new Error(
      'No owner connection string. Expected POSTGRES_URL_NON_POOLING (Supabase) or DATABASE_MIGRATION_URL.',
    );
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.log('Applying schema migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });

  console.log('Applying RLS policies and grants…');
  const policies = await readFile(join(process.cwd(), 'drizzle', 'policies.sql'), 'utf8');
  await db.execute(sql.raw(policies));

  await client.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

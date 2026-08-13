import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * The raw database handle.
 *
 * Feature modules must never import this file — they receive space-scoped repositories
 * instead, so `space_id` is impossible to forget (DESIGN.md §3.5). The ESLint rule in
 * eslint.config.mjs enforces that; this comment explains why it exists.
 */

/**
 * postgres.js opens no socket until the first query, so constructing this at import
 * time costs nothing and keeps `next build` working without a database. The placeholder
 * host exists to make a missing DATABASE_URL fail legibly at query time rather than
 * turning every import of this module into a crash.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://unset@database-url-is-not-configured:5432/unset';

/**
 * `prepare: false` keeps this compatible with transaction-mode poolers (pgbouncer,
 * Supabase's pooled port). Note the open question in DESIGN.md §12: RLS relies on
 * `SET LOCAL` inside a transaction, which is only safe under transaction pooling —
 * verify against the pooler you actually deploy with.
 */
const client = postgres(connectionString, {
  prepare: false,
  max: process.env.NODE_ENV === 'production' ? 10 : 3,
});

export const db = drizzle(client, { schema });

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';
import { getSpaceContext } from '@/core/context/resolve';
import { readInSpace } from '@/core/db/unit-of-work';
import { spacesForUser } from '@/modules/identity';
import { SpaceSwitcher } from './space-switcher';
import { AppTabs, type TabId } from './tabs';

/**
 * Whose records these are, who is looking, and the tabs — identical on every section.
 *
 * It resolves its own context rather than taking one as a prop. Five screens all needed the
 * same three reads, and passing them down meant every new screen re-deriving a header; the
 * pages are `force-dynamic` and space-scoped anyway, so the queries are the same ones the
 * page is already making against the same request.
 */

const ROLE_LABEL = { owner: 'מנהל/ת', editor: 'עורך/ת', viewer: 'צופה' } as const;

export async function AppHeader({ active }: { active: TabId }) {
  const session = await auth();
  const ctx = await getSpaceContext();
  if (!session?.user?.id || !ctx) redirect('/');

  const [space, memberships] = await Promise.all([
    readInSpace(ctx, (repos) => repos.space.get()),
    spacesForUser(session.user.id),
  ]);

  return (
    // No border of its own: the tab row underneath carries it, so the two do not stack.
    <header>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          {/*
            The name is the way into the space's own settings — the same gesture as tapping
            an account name to configure it. It stays a heading: this is still what the page
            is about, and a link that is only reachable from a tab row would need a sixth tab
            for a screen most people open twice.
          */}
          <h1 className="text-xl font-semibold">
            <Link
              href="/settings"
              aria-label={`הגדרות המרחב${space?.name ? ` — ${space.name}` : ''}`}
              className="rounded hover:underline focus-visible:outline focus-visible:outline-2"
            >
              {space?.name}
              <span aria-hidden="true" className="ms-1.5 align-middle text-sm text-neutral-400">⚙</span>
            </Link>
          </h1>
          <p className="text-sm text-neutral-500">
            {session.user.name} · {ROLE_LABEL[ctx.role]}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SpaceSwitcher
            spaces={memberships.map((membership) => ({
              spaceId: membership.spaceId,
              spaceName: membership.spaceName,
              subjectName: membership.subjectName,
            }))}
            activeSpaceId={ctx.spaceId}
          />
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/' });
            }}
          >
            <button type="submit" className="text-sm text-neutral-500 hover:text-neutral-900">יציאה</button>
          </form>
        </div>
      </div>

      <AppTabs active={active} />
    </header>
  );
}

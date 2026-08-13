import Link from 'next/link';

/**
 * The top-level tabs.
 *
 * Six sections that are each a place rather than a step, so they are peers on one row
 * instead of pages reached by a back link. Every section keeps its own URL — these are
 * links, not client-side state — which is what lets anything in the app hand off to a tab
 * by linking to it. The file screen depends on that: a document is clicked anywhere and
 * lands in `קבצים`.
 *
 * A server component on purpose. The active tab is known from the route the server is
 * already rendering, so this ships no JavaScript.
 */

/**
 * `settings` is deliberately a TabId with no tab.
 *
 * The settings screen is reached by tapping the space name in the header, not from this row —
 * it configures the app rather than being somewhere you go about someone's care, and six
 * Hebrew labels already overflow a 375px phone. It still needs a value to pass as `active`,
 * and giving it one that matches nothing below leaves every tab correctly unhighlighted
 * instead of lighting up whichever one it was told to pretend to be.
 */
export type TabId = 'home' | 'calendar' | 'files' | 'correspondence' | 'members' | 'usage' | 'settings';

const TABS: ReadonlyArray<{ id: TabId; href: string; label: string }> = [
  { id: 'home', href: '/', label: 'ראשי' },
  { id: 'calendar', href: '/calendar', label: 'לוח שנה' },
  { id: 'files', href: '/files', label: 'קבצים' },
  { id: 'correspondence', href: '/correspondence', label: 'פניות' },
  { id: 'members', href: '/members', label: 'חברים' },
  // Last on purpose: it is the only tab about the app rather than about the person the
  // records are for, so it sits after everything someone opens the app to do.
  { id: 'usage', href: '/usage', label: 'שימוש AI' },
];

export function AppTabs({ active }: { active: TabId }) {
  return (
    // Scrollable rather than wrapping: six Hebrew labels no longer fit a 375px phone, and
    // pushing sideways is what this was built for — a second row would move the content
    // down the page for everyone to make room for a tab most people rarely open.
    <nav aria-label="ניווט ראשי" className="-mx-6 mt-4 overflow-x-auto px-6 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-neutral-200">
        {TABS.map((tab) => {
          const current = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={current ? 'page' : undefined}
                className={`-mb-px block border-b-2 px-3 py-2.5 text-sm transition ${
                  current
                    ? 'border-neutral-900 font-medium text-neutral-900'
                    : 'border-transparent text-neutral-500 hover:text-neutral-900'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

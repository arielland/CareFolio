import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSpaceContext } from '@/core/context/resolve';
import { getUsageReport, type UsageCall, type UsageWindow } from '@/modules/usage';
import { AppHeader } from '../app-header';

export const dynamic = 'force-dynamic';

/**
 * What the app has spent on AI, and on what.
 *
 * The app makes a model call every time someone scans a document, and a hundred of them
 * when someone imports a folder. That was previously invisible from inside the app: the
 * only record was the Anthropic console, which knows the total and nothing about *which
 * space*, *which document*, or *which afternoon*. This screen is the missing half.
 *
 * It reads `app_log`, which the logging sink writes as each call completes — so every
 * number here is a sum over rows that were priced at the moment they happened, not a
 * recomputation against today's tariff (see `core/llm/pricing.ts`).
 *
 * Everything is stated as an estimate, because it is one. Cached input tokens bill at
 * about a tenth of the input rate and the API's usage payload does not break them out, so
 * the figure is an upper bound. Saying "אומדן" costs nothing; letting someone plan against
 * a number that quietly claims more precision than it has does not.
 */

const OPERATION_LABEL: Record<string, string> = {
  extractFromDocument: 'קריאת מסמך סרוק',
  extractFromText: 'קריאת מסמך עם שכבת טקסט',
  complete: 'ניסוח וסיכום',
};

const WINDOWS: ReadonlyArray<{ id: UsageWindow; label: string }> = [
  { id: 'month', label: 'החודש' },
  { id: 'all', label: 'הכל' },
];

/**
 * Four decimals, because a single cheap call rounds to $0.00 at two and a screen that
 * shows a column of zeros beside a non-zero total is a screen nobody believes.
 */
const usd = (value: number) => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const tokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}K`
      : String(value);

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const params = await searchParams;
  const window: UsageWindow = params.window === 'all' ? 'all' : 'month';
  const report = await getUsageReport(ctx, { window });

  const peakCost = Math.max(...report.byDay.map((day) => day.costUsd), 0);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="usage" />

      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium">שימוש במודל שפה</h2>
        <div className="flex items-center gap-1">
          {WINDOWS.map((option) => (
            <Link
              key={option.id}
              href={option.id === 'month' ? '/usage' : `/usage?window=${option.id}`}
              aria-current={option.id === window ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                option.id === window
                  ? 'bg-neutral-900 text-white'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              {option.label}
            </Link>
          ))}
        </div>
      </div>

      {report.totals.calls === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          {window === 'month'
            ? 'לא בוצעו קריאות למודל בחודש הזה.'
            : 'עדיין לא בוצעו קריאות למודל במרחב הזה.'}
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="קריאות" value={String(report.totals.calls)} />
            <Stat label="טוקנים נכנסים" value={tokens(report.totals.tokensIn)} />
            <Stat label="טוקנים יוצאים" value={tokens(report.totals.tokensOut)} />
            <Stat label="עלות משוערת" value={usd(report.totals.costUsd)} />
          </div>

          <p className="mt-2 text-xs text-neutral-500">
            אומדן לפי מחירון רשמי. קלט שנקרא מהמטמון מחויב בפחות, והנתון הזה לא מבחין בו — כלומר
            העלות בפועל שווה או נמוכה יותר.
            {report.totals.unpriced > 0 && (
              <span className="text-amber-700">
                {' '}
                {report.totals.unpriced} קריאות בוצעו במודל שאין לו מחיר רשום, והן אינן נכללות בסכום.
              </span>
            )}
          </p>

          <Section title="לפי סוג פעולה">
            <ul className="divide-y divide-neutral-200">
              {report.byOperation.map((row) => (
                <li
                  key={`${row.operation}-${row.model}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      {OPERATION_LABEL[row.operation ?? ''] ?? row.operation ?? 'לא ידוע'}
                    </span>
                    <span className="ms-2 text-sm text-neutral-500">{row.model}</span>
                  </span>
                  <span className="text-sm text-neutral-500">
                    {row.calls} קריאות · {tokens(row.tokensIn + row.tokensOut)} טוקנים
                    <span className="ms-2 tabular-nums text-neutral-900">{usd(row.costUsd)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          {report.byDay.length > 0 && (
            <Section title="לפי יום">
              {/* A bar per day rather than a chart library: the only question this answers
                  is "which day was expensive", and a width in percent answers it. */}
              <ul className="space-y-1.5">
                {report.byDay.map((day) => (
                  <li key={day.day} className="flex items-center gap-3 text-sm">
                    <span className="w-14 shrink-0 tabular-nums text-neutral-500">
                      {Number(day.day.slice(8))}.{Number(day.day.slice(5, 7))}
                    </span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
                      <span
                        className="block h-full rounded-full bg-neutral-900"
                        style={{ width: `${peakCost > 0 ? (day.costUsd / peakCost) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="w-24 shrink-0 text-end tabular-nums text-neutral-500">
                      {day.calls} · {usd(day.costUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {/* Always shown once anything exists, whatever the window: "what did it just do"
          is the question someone has right after a scan felt slow or expensive. */}
      {report.recent.length > 0 && (
        <Section title="קריאות אחרונות">
          <ul className="divide-y divide-neutral-200">
            {report.recent.map((call) => (
              <RecentCall key={call.id} call={call} />
            ))}
          </ul>
        </Section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h3 className="text-sm font-medium tracking-wide text-neutral-500">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RecentCall({ call }: { call: UsageCall }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
      <span className="min-w-0">
        <span className="font-medium">
          {OPERATION_LABEL[call.operation ?? ''] ?? call.operation ?? 'קריאה'}
        </span>
        {/* Named because in a shared space "who ran the import" is a real question, and
            because a call with nobody behind it is a script, which is worth seeing. */}
        <span className="ms-2 text-neutral-500">{call.userName ?? 'האפליקציה'}</span>
      </span>
      <span className="text-neutral-500">
        <time dateTime={call.createdAt.toISOString()}>
          {call.createdAt.toLocaleString('he-IL', {
            timeZone: 'Asia/Jerusalem',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
        {call.durationMs !== null && (
          <span className="ms-2 tabular-nums">{(call.durationMs / 1000).toFixed(1)}s</span>
        )}
        {call.costUsd !== null && (
          <span className="ms-2 tabular-nums text-neutral-900">{usd(call.costUsd)}</span>
        )}
      </span>
    </li>
  );
}

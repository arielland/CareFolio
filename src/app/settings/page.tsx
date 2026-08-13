import { redirect } from 'next/navigation';
import { getSpaceContext } from '@/core/context/resolve';
import { readInSpace } from '@/core/db/unit-of-work';
import { getSpaceSettings, importReadiness } from '@/modules/documents';
import { AppHeader } from '../app-header';
import { BulkImport } from './bulk-import';
import { DriveImportSetting } from './drive-import';
import { ScanScope } from './scan-scope';

export const dynamic = 'force-dynamic';

/**
 * The space's own settings, reached by tapping the name at the top of any screen.
 *
 * Not a tab. The five tabs are places you go to do something about a person's care; this is
 * about the app's own behaviour, and it belongs behind the thing it configures — the space
 * name — rather than competing for a phone's width with לוח שנה and קבצים.
 *
 * Everything here is space-scoped, and every member can read it: in shared caregiving,
 * "how does this app read our documents" is not an admin secret. Changing it is the owner's,
 * and that is enforced in the module rather than by hiding the control (DESIGN.md §3.2) —
 * the radio buttons are simply disabled and say why.
 */

const IMPORT_MESSAGES: Record<string, string> = {
  connected: 'ההרשאה אושרה. אפשר לבחור תיקייה ב-Drive ולייבא ממנה.',
  declined: 'האישור בוטל. ייבוא מתיקייה ב-Drive לא יעבוד בלעדיו — ייבוא מהמחשב עדיין זמין.',
  missing_scope: 'ההרשאה שניתנה לא כללה קריאת קבצים. יש לנסות שוב ולאשר.',
  failed: 'האישור נכשל. אפשר לנסות שוב.',
  /** Reached by typing the consent URL while the option is off — see the connect route. */
  disabled: 'ייבוא מתיקייה ב-Drive כבוי בהגדרות המרחב, ולכן ההרשאה לא התבקשה.',
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ import?: string }>;
}) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const params = await searchParams;
  const [space, settings, importing] = await Promise.all([
    readInSpace(ctx, (repos) => repos.space.get()),
    getSpaceSettings(ctx),
    importReadiness(ctx),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="settings" />

      <div className="mt-6">
        <h2 className="text-lg font-medium">הגדרות</h2>
        <p className="text-sm text-neutral-500">הרשומות של {space?.subjectName}</p>
      </div>

      {params.import && IMPORT_MESSAGES[params.import] && (
        <p
          className={`mt-4 rounded-lg p-3 text-sm ${
            params.import === 'connected' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
          }`}
        >
          {IMPORT_MESSAGES[params.import]}
        </p>
      )}

      <ScanScope firstPageOnly={settings.firstPageOnly} canChange={ctx.role === 'owner'} />

      {/* Above the import screen, because it decides what that screen is allowed to offer. */}
      <DriveImportSetting
        enabled={settings.driveImportEnabled}
        connected={importing.connected}
        isAdmin={importing.allowed}
        canChange={ctx.role === 'owner'}
      />

      <BulkImport
        canImport={ctx.role !== 'viewer'}
        driveEnabled={settings.driveImportEnabled}
        driveAllowed={importing.allowed}
        driveConnected={importing.connected}
      />

      <section className="mt-10 rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-sm text-neutral-600">
        <h2 className="font-medium text-neutral-900">מה קורה כשמייבאים מסמך</h2>
        <p className="mt-2">
          הקובץ נשמר בתיקיית האפליקציה ב-Google Drive של מנהל/ת המרחב, והפרטים —
          שם, סוג, תאריך, מוסד, רופא/ה ותגיות — מחולצים על ידי מודל שפה. תוכן המסמך נשלח
          לצורך כך לספק המודל.
        </p>
        <p className="mt-2">
          קובץ PDF שכבר מכיל טקסט נקרא ישירות מהקובץ, בלי לשלוח את התמונה — מהיר יותר, זול
          יותר ומדויק יותר.
        </p>
      </section>
    </main>
  );
}

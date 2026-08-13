'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { switchSpace } from './actions';

/**
 * Which person's records you are looking at.
 *
 * It appears only when there is a choice to make. Before Phase 3 there never was — every
 * user had exactly one space — and a switcher offering one option is a control that
 * teaches nothing and takes up the top of the screen anyway.
 *
 * The name shown is the *subject's*: in the case this app is built around, an adult child
 * managing a parent's care, "אמא" is the only label that answers the question being asked.
 */
export function SpaceSwitcher({
  spaces,
  activeSpaceId,
}: {
  spaces: Array<{ spaceId: string; spaceName: string; subjectName: string }>;
  activeSpaceId: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (spaces.length < 2) return null;

  return (
    <select
      aria-label="מרחב פעיל"
      className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-40"
      value={activeSpaceId}
      disabled={pending}
      onChange={(e) => {
        const spaceId = e.target.value;
        startTransition(async () => {
          await switchSpace(spaceId);
          // The page reads the cookie on the server, so the new value only takes effect
          // on a fresh render.
          router.refresh();
        });
      }}
    >
      {spaces.map((space) => (
        <option key={space.spaceId} value={space.spaceId}>
          {space.subjectName}
        </option>
      ))}
    </select>
  );
}

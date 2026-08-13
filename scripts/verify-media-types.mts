import {
  extensionFor,
  isStorableDocumentType,
  normalizeMediaType,
  servableTypeFor,
  STORABLE_DOCUMENT_TYPES,
} from '@/modules/documents/internal/media-types';
import { isSupportedRecordingType } from '@/modules/visits';

/**
 * The media-type allowlist that decides what `/api/files/[id]` may name in a `Content-Type`.
 *
 * Worth its own check because the failure is invisible and total. These routes return stored
 * bytes from the app's own origin, so a type that escapes this list — `text/html`,
 * `image/svg+xml` — is script running in the session of whoever opened the document, with
 * reach into every server action and every other file that member can see. Nothing about the
 * response looks wrong when it happens.
 *
 * The dangerous types below are checked by name rather than by property, because the point
 * is not that the function has a sensible shape; it is that these specific strings, which are
 * what an attacker would actually reach for, do not get through.
 *
 * Needs no database, no network and no fixtures. Run with: npm run verify:media-types
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** What a payload would have to be delivered as to execute on this origin. */
const EXECUTABLE = [
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/x-httpd-php',
];

function main() {
  console.log('--- what may be stored and served\n');

  for (const [type, extension] of Object.entries(STORABLE_DOCUMENT_TYPES)) {
    check(`${type} is storable`, isStorableDocumentType(type));
    check(`  and names itself on the wire`, servableTypeFor(type) === type);
    check(`  and carries the extension a person can open`, extensionFor(type) === extension, extension);
  }

  console.log('\n--- what may not\n');

  for (const type of EXECUTABLE) {
    check(`${type} is refused`, !isStorableDocumentType(type));
    check(`  and is never named on the wire`, servableTypeFor(type) === null);
    // The route serves an unnameable type as application/octet-stream; the extension is
    // what the stored filename would carry, and it must not suggest something openable.
    check(`  and cannot borrow an extension`, extensionFor(type) === 'bin', extensionFor(type));
  }

  console.log('\n--- parameters and casing do not smuggle a type past the check\n');

  check('a charset parameter is stripped', normalizeMediaType('image/jpeg; charset=binary') === 'image/jpeg');
  check('and the type still passes', isStorableDocumentType('image/jpeg; charset=binary'));
  check('uppercase is normalized', isStorableDocumentType('IMAGE/JPEG'));
  check('surrounding whitespace is trimmed', isStorableDocumentType('  application/pdf  '));
  // The reverse of the above: normalization must not become a way in.
  check('a parameter cannot smuggle html through', !isStorableDocumentType('text/html; charset=utf-8'));
  check('nor can casing', !isStorableDocumentType('Text/HTML'));
  check('nor can a lookalike prefix', !isStorableDocumentType('image/png.html'));
  check('an empty type is refused', !isStorableDocumentType(''));

  console.log('\n--- prototype keys are not types\n');

  // `in` on a plain object literal reaches the prototype chain, so these have to be checked
  // rather than assumed: `'constructor' in {}` is true.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    check(`${key} is not a storable type`, !isStorableDocumentType(key));
    check(`  and names nothing`, servableTypeFor(key) === null);
  }

  console.log('\n--- recordings answer the same question separately\n');

  check('a browser recording type is playable', isSupportedRecordingType('audio/webm'));
  check('with its codec parameter attached', isSupportedRecordingType('audio/webm;codecs=opus'));
  check('html is not a recording', !isSupportedRecordingType('text/html'));
  check('nor is svg', !isSupportedRecordingType('image/svg+xml'));
  // The two lists are deliberately separate; neither should accept the other's members.
  check('a document type is not a recording', !isSupportedRecordingType('application/pdf'));
  check('a recording type is not a document', !isStorableDocumentType('audio/webm'));

  console.log(failures === 0 ? '\nAll media-type checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

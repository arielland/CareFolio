import { log } from '@/core/logging/logger';

/**
 * The two browser globals pdfjs insists on existing before it will load at all.
 *
 * This is here because of a production failure, not a hypothetical. pdfjs polyfills
 * `DOMMatrix` and `Path2D` in Node from `@napi-rs/canvas` — an **optional** dependency — and
 * then, at module top level, evaluates `const SCALE_MATRIX = new DOMMatrix()`. When the
 * optional package is not installed for the running platform, the polyfill degrades to a
 * `warn` and the very next line throws:
 *
 *   Error: Failed to load external module pdfjs-dist-…/legacy/build/pdf.mjs:
 *   ReferenceError: DOMMatrix is not defined
 *
 * Which is exactly what happened on Vercel while working perfectly on a Windows laptop that
 * had the `win32-x64-msvc` binary sitting in `node_modules`. The failure is total — the module
 * never loads, so *every* PDF import fails — and it is invisible locally.
 *
 * The alternative fix is to depend on `@napi-rs/canvas` outright and ship a native binary to
 * production. This app never renders a PDF. It calls `getTextContent()` and nothing else, so
 * that would be tens of megabytes of native code, on every cold start, to satisfy a
 * constructor call that runs once and whose result is never used on our path.
 *
 * So: the smallest honest stand-ins. The constructors are real — they parse what the spec
 * says they parse, so anything that reads `a`–`f` gets the right numbers — and every method
 * that would perform an actual transform **throws with an explanation**. That is deliberate.
 * A stub that quietly returned an identity matrix would make a future rendering path produce
 * subtly wrong output; this one stops it dead at the first call, with a sentence saying why
 * and what to install.
 */

const RENDERING_UNSUPPORTED =
  'This build of the app extracts PDF text and cannot render PDFs: DOMMatrix/Path2D are ' +
  'minimal stubs (adapters/pdf/dom-stubs.ts). Add @napi-rs/canvas as a real dependency if ' +
  'rendering is ever needed.';

class TextOnlyDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  /**
   * Accepts what pdfjs passes it: nothing, or a six-element transform. A sixteen-element
   * 3D matrix is read for its 2D components, which is what the real thing does too.
   */
  constructor(init?: number[] | string) {
    if (!Array.isArray(init)) return;

    if (init.length === 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    } else if (init.length === 16) {
      this.a = init[0];
      this.b = init[1];
      this.c = init[4];
      this.d = init[5];
      this.e = init[12];
      this.f = init[13];
    }
  }

  multiplySelf(): never { throw new Error(RENDERING_UNSUPPORTED); }
  preMultiplySelf(): never { throw new Error(RENDERING_UNSUPPORTED); }
  invertSelf(): never { throw new Error(RENDERING_UNSUPPORTED); }
  translate(): never { throw new Error(RENDERING_UNSUPPORTED); }
  scale(): never { throw new Error(RENDERING_UNSUPPORTED); }
  transformPoint(): never { throw new Error(RENDERING_UNSUPPORTED); }
}

class TextOnlyPath2D {
  addPath(): never { throw new Error(RENDERING_UNSUPPORTED); }
  moveTo(): never { throw new Error(RENDERING_UNSUPPORTED); }
  lineTo(): never { throw new Error(RENDERING_UNSUPPORTED); }
  closePath(): never { throw new Error(RENDERING_UNSUPPORTED); }
}

/**
 * Installs the stubs, and only where they are missing.
 *
 * The order matters and is the whole point: pdfjs's own polyfill is guarded by
 * `if (!globalThis.DOMMatrix)`, so whatever is present when it loads wins. Calling this
 * before importing pdfjs means the stub is used on every platform — including the developer
 * laptop that has the native package — so local behaviour matches production instead of
 * being quietly better than it.
 */
export function installPdfDomStubs(): void {
  const globals = globalThis as Record<string, unknown>;
  let installed = false;

  if (!globals.DOMMatrix) {
    globals.DOMMatrix = TextOnlyDOMMatrix;
    installed = true;
  }
  if (!globals.Path2D) {
    globals.Path2D = TextOnlyPath2D;
    installed = true;
  }

  if (installed) {
    log.debug('pdf.dom_stubs.installed', { module: 'adapters/pdf' });
  }
}

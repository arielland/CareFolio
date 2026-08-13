import { GoogleDriveAdapter } from '@/adapters/google/drive';
import { GoogleDriveImport } from '@/adapters/google/drive-import';
import { GoogleCalendarAdapter } from '@/adapters/google/calendar';
import { GoogleConnection } from '@/adapters/google/connection';
import { GmailAdapter } from '@/adapters/google/gmail';
import { ClaudeAdapter } from '@/adapters/claude/llm';
import { PdfJsTextLayer } from '@/adapters/pdf/text-layer';
import type { CalendarPort } from './ports/calendar';
import type { EmailPort } from './ports/email';
import type { FileStoragePort } from './ports/file-storage';
import type { ImportSourcePort } from './ports/file-import';
import type { LlmPort } from './ports/llm';
import type { PdfTextPort } from './ports/pdf-text';
import type { ProviderConnectionPort } from './ports/provider-connection';

/**
 * The composition root — the only place adapters are named.
 *
 * Feature modules import from here (or receive these as arguments) and see nothing but
 * the port types, which is what keeps the swap in DESIGN.md §4 to a one-line change.
 * The ESLint rule in eslint.config.mjs stops a module from reaching past this file to
 * an adapter directly.
 */

let fileStorage: FileStoragePort | undefined;
let importSource: ImportSourcePort | undefined;
let calendar: CalendarPort | undefined;
let providerConnection: ProviderConnectionPort | undefined;
let email: EmailPort | undefined;
let llm: LlmPort | undefined;
let pdfText: PdfTextPort | undefined;

export function getFileStorage(): FileStoragePort {
  fileStorage ??= new GoogleDriveAdapter();
  return fileStorage;
}

/**
 * Where documents are imported *from*, which is not where they are kept — see the note in
 * `ports/file-import.ts` for why those are two ports and two grants.
 */
export function getImportSource(): ImportSourcePort {
  importSource ??= new GoogleDriveImport();
  return importSource;
}

export function getCalendar(): CalendarPort {
  calendar ??= new GoogleCalendarAdapter();
  return calendar;
}

export function getProviderConnection(): ProviderConnectionPort {
  providerConnection ??= new GoogleConnection();
  return providerConnection;
}

export function getEmail(): EmailPort {
  email ??= new GmailAdapter();
  return email;
}

export function getLlm(): LlmPort {
  llm ??= new ClaudeAdapter();
  return llm;
}

/** Reading what a PDF already says, so a model is not paid to read it again. */
export function getPdfText(): PdfTextPort {
  pdfText ??= new PdfJsTextLayer();
  return pdfText;
}

/** Test seam: swap in fakes without touching the modules under test. */
export function __setPorts(ports: {
  fileStorage?: FileStoragePort;
  importSource?: ImportSourcePort;
  calendar?: CalendarPort;
  providerConnection?: ProviderConnectionPort;
  email?: EmailPort;
  llm?: LlmPort;
  pdfText?: PdfTextPort;
}): void {
  if (ports.fileStorage) fileStorage = ports.fileStorage;
  if (ports.importSource) importSource = ports.importSource;
  if (ports.calendar) calendar = ports.calendar;
  if (ports.providerConnection) providerConnection = ports.providerConnection;
  if (ports.email) email = ports.email;
  if (ports.llm) llm = ports.llm;
  if (ports.pdfText) pdfText = ports.pdfText;
}

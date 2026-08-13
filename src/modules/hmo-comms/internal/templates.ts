/**
 * The request flows, as typed templates (DESIGN.md §5, M3).
 *
 * Written for כללית, which is what this space deals with. The wording is deliberately
 * plain and slightly formal — these are read by a clerk with a queue, and the fastest
 * request to process is the one that states who, what, and which document, in that order.
 *
 * A template is data, not code: fields, a subject line, and a body builder. Adding a fourth
 * flow means adding an entry here and nothing else, and adapting to another kupah means
 * changing the strings rather than the module.
 *
 * **No national ID field.** A תעודת זהות would speed the clerk up, and it is the single
 * most sensitive identifier a person has. Storing one per space is a deliberate decision
 * about Israeli privacy obligations that nobody has made yet (DESIGN.md §12), so for now it
 * is a line the writer can add to the body themselves if they judge it appropriate.
 */

export type FlowType = 'prescription_conversion' | 'commitment_form' | 'general_inquiry';

export interface TemplateField {
  name: string;
  label: string;
  placeholder?: string;
  /** Renders as a textarea rather than a single line. */
  multiline?: boolean;
  required?: boolean;
}

export interface FlowTemplate {
  type: FlowType;
  label: string;
  /** What this flow is for, in the words someone would use to look for it. */
  description: string;
  /** Shown where documents are picked, so the right ones get attached. */
  attachmentHint: string;
  /** True when going without an attachment almost certainly means a rejected request. */
  attachmentsExpected: boolean;
  fields: TemplateField[];
  subject: (values: Record<string, string>, subjectName: string) => string;
  body: (values: Record<string, string>, subjectName: string) => string;
}

/** Trims, and drops the line entirely when its value is empty. */
const line = (label: string, value: string | undefined) =>
  value?.trim() ? `${label}: ${value.trim()}` : null;

const compose = (parts: Array<string | null>) => parts.filter((part) => part !== null).join('\n');

const SIGN_OFF = 'בברכה,';

export const FLOW_TEMPLATES: Record<FlowType, FlowTemplate> = {
  prescription_conversion: {
    type: 'prescription_conversion',
    label: 'המרת מרשם פרטי למרשם קופה',
    description: 'רופא פרטי נתן מרשם, ואתם רוצים לקבל אותו דרך הקופה.',
    attachmentHint: 'צרפו את המרשם של הרופא הפרטי.',
    attachmentsExpected: true,
    fields: [
      { name: 'medication', label: 'שם התרופה והמינון', placeholder: 'לדוגמה: Eltroxin 50 מק"ג', required: true },
      { name: 'prescribedBy', label: 'הרופא שנתן את המרשם', placeholder: 'שם ותחום' },
      { name: 'prescribedOn', label: 'תאריך המרשם', placeholder: 'לדוגמה: 12.7.2026' },
      { name: 'pharmacy', label: 'בית מרקחת מועדף לאיסוף' },
      { name: 'notes', label: 'הערות', multiline: true },
    ],
    subject: (values, subjectName) => `בקשה להמרת מרשם — ${subjectName}${values.medication ? ` — ${values.medication}` : ''}`,
    body: (values, subjectName) =>
      compose([
        'שלום רב,',
        '',
        `אבקש להמיר מרשם שניתן על ידי רופא פרטי למרשם קופה עבור ${subjectName}.`,
        '',
        line('תרופה ומינון', values.medication),
        line('נרשם על ידי', values.prescribedBy),
        line('תאריך המרשם', values.prescribedOn),
        line('בית מרקחת לאיסוף', values.pharmacy),
        line('הערות', values.notes),
        '',
        'המרשם המקורי מצורף.',
        '',
        SIGN_OFF,
      ]),
  },

  commitment_form: {
    type: 'commitment_form',
    label: 'בקשת התחייבות (טופס 17)',
    description: 'התחייבות כספית לבדיקה, טיפול או ניתוח אצל ספק חיצוני.',
    attachmentHint: 'צרפו את ההפניה של הרופא, ומסמכים קודמים שרלוונטיים לבקשה.',
    attachmentsExpected: true,
    fields: [
      { name: 'procedure', label: 'הבדיקה או הטיפול המבוקש', placeholder: 'לדוגמה: MRI כתף ימין', required: true },
      { name: 'provider', label: 'הספק / בית החולים', placeholder: 'שם המוסד שבו יתבצע', required: true },
      { name: 'referredBy', label: 'הרופא המפנה', placeholder: 'שם ותחום' },
      { name: 'scheduledFor', label: 'מועד שנקבע', placeholder: 'אם כבר נקבע תור' },
      { name: 'notes', label: 'הערות', multiline: true },
    ],
    subject: (values, subjectName) => `בקשת טופס 17 — ${subjectName}${values.procedure ? ` — ${values.procedure}` : ''}`,
    body: (values, subjectName) =>
      compose([
        'שלום רב,',
        '',
        `אבקש טופס התחייבות (טופס 17) עבור ${subjectName}.`,
        '',
        line('הבדיקה או הטיפול', values.procedure),
        line('הספק המבצע', values.provider),
        line('רופא מפנה', values.referredBy),
        line('מועד שנקבע', values.scheduledFor),
        line('הערות', values.notes),
        '',
        'ההפניה מצורפת.',
        '',
        // A commitment form that arrives after the appointment is worth nothing, and the
        // clerk cannot know the date is close unless it is said.
        values.scheduledFor?.trim()
          ? 'אשמח לקבל את ההתחייבות לפני המועד שנקבע.'
          : 'אשמח לדעת מה משך הטיפול בבקשה.',
        '',
        SIGN_OFF,
      ]),
  },

  general_inquiry: {
    type: 'general_inquiry',
    label: 'פנייה כללית',
    description: 'כל דבר אחר — בירור זכאות, מעקב אחרי בקשה קודמת, שאלה על החזר.',
    attachmentHint: 'צרפו מסמכים אם הם עוזרים להסביר את הפנייה.',
    attachmentsExpected: false,
    fields: [
      { name: 'topic', label: 'נושא הפנייה', placeholder: 'במשפט אחד', required: true },
      { name: 'details', label: 'פירוט', multiline: true, required: true },
    ],
    subject: (values, subjectName) => `${values.topic?.trim() || 'פנייה'} — ${subjectName}`,
    body: (values, subjectName) =>
      compose([
        'שלום רב,',
        '',
        `אני פונה בעניין ${subjectName}.`,
        '',
        values.details?.trim() ?? '',
        '',
        SIGN_OFF,
      ]),
  },
};

export const FLOW_LIST: readonly FlowTemplate[] = Object.values(FLOW_TEMPLATES);

export class UnknownFlowError extends Error {
  constructor(flowType: string) {
    super(`No such correspondence flow: ${flowType}`);
    this.name = 'UnknownFlowError';
  }
}

export function templateFor(flowType: string): FlowTemplate {
  const template = FLOW_TEMPLATES[flowType as FlowType];
  if (!template) throw new UnknownFlowError(flowType);
  return template;
}

export interface ComposedMessage {
  subject: string;
  body: string;
}

/**
 * Renders a flow into a subject and body, with the sender's name appended.
 *
 * The result is a starting point, not a finished message: it is stored as a draft and shown
 * for editing before anything is sent, because the app never sends autonomously and because
 * no template survives contact with a real request (DESIGN.md §11).
 */
export function composeMessage(input: {
  flowType: string;
  values: Record<string, string>;
  subjectName: string;
  senderName: string | null;
}): ComposedMessage {
  const template = templateFor(input.flowType);
  const body = template.body(input.values, input.subjectName);

  return {
    subject: template.subject(input.values, input.subjectName),
    body: input.senderName?.trim() ? `${body}\n${input.senderName.trim()}` : body,
  };
}

export function missingRequiredFields(flowType: string, values: Record<string, string>): string[] {
  return templateFor(flowType)
    .fields.filter((field) => field.required && !values[field.name]?.trim())
    .map((field) => field.label);
}

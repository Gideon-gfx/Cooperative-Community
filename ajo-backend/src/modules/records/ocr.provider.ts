import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { HttpError } from '../../lib/errors';
import { FIELDS } from './records.logic';
import type { RecordType } from '@prisma/client';

// OCR only ever SUGGESTS. Handwriting is unreliable, so every provider returns a confidence per field and a human
// accepts or edits every row before anything becomes a record.

export interface OcrRow {
  /** Field name → text as read, e.g. { name: 'Adé Bello', amount: '5,000', date: '14/3/23' } */
  fields: Record<string, string>;
  /** Field name → 0..1. Missing means the reader gave no score. */
  confidence: Record<string, number>;
  rawText: string;
  /** Where on the page the row sits, as fractions of the page (0..1), for the side-by-side crop. */
  box?: { x: number; y: number; w: number; h: number };
  page?: number;
}

export interface OcrResult { rows: OcrRow[]; fullText: string }
export interface OcrInput { data: Buffer; mime: string; recordType: RecordType; language: string }

export interface OcrProvider {
  readonly name: string;
  extract(input: OcrInput): Promise<OcrResult>;
}

const MODEL = 'claude-opus-5-5';

/** Hints that matter for Nigerian ledgers: Yorùbá tone marks and under-dots, honorifics, day-first dates, naira. */
export function ocrHints(language: string): string {
  return [
    'These are pages from a Nigerian community savings (àjọ / esusu) or cooperative book, often handwritten.',
    'Names may carry Yorùbá tone marks and under-dots (Ọlá, Ẹniọlá, Ṣadé, Àbáké): keep every mark you can read, and never "correct" a name to a more common one.',
    'Honorifics such as Mama, Baba, Alhaja, Alhaji, Chief, Madam and Iya are part of how people are written down: keep them in the name.',
    'Dates are written day first (14/03/2023). Amounts are in naira and may be written ₦5,000, N5000 or 5k.',
    `The writer's language is: ${language}.`,
  ].join(' ');
}

const rowSchema = (recordType: RecordType) => {
  const f = FIELDS[recordType];
  const fieldProps = Object.fromEntries([...f.required, ...f.optional].map((k) => [k, { type: 'string' }]));
  const confProps = Object.fromEntries([...f.required, ...f.optional].map((k) => [k, { type: 'number' }]));
  return {
    type: 'object',
    additionalProperties: false,
    required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fields', 'confidence', 'rawText', 'page', 'box'],
          properties: {
            fields: { type: 'object', additionalProperties: false, required: [...f.required], properties: fieldProps },
            confidence: { type: 'object', additionalProperties: false, properties: confProps },
            rawText: { type: 'string' },
            page: { type: 'integer' },
            box: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
          },
        },
      },
    },
  };
};

/**
 * Primary adapter: a vision-language model. It copes with messy tables and mixed handwriting and print better than classic
 * OCR in most cases. Needs ANTHROPIC_API_KEY. Verify on real ledger pages with scripts/ocr-bakeoff.ts.
 */
export class VisionModelOcrProvider implements OcrProvider {
  readonly name = 'vision-model';
  private client = new Anthropic();

  async extract({ data, mime, recordType, language }: OcrInput): Promise<OcrResult> {
    const media: Anthropic.Beta.BetaContentBlockParam =
      mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } }
        : { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: data.toString('base64') } };
    const f = FIELDS[recordType];
    const res = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: rowSchema(recordType) } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: `You read pages of handwritten and printed ledgers and return one row per entry. ${ocrHints(language)} Return exactly what is written: do not guess a missing value (leave it empty and give it a low confidence), do not add rows that are not on the page, do not total or fix anything. For each field give a confidence from 0 to 1 for how sure you are of it. Fields to read: ${[...f.required, ...f.optional].join(', ')}. Give each row's position on its page as fractions (x, y, w, h).`,
      messages: [{ role: 'user', content: [media, { type: 'text', text: `Read every entry on this page. Record type: ${recordType}.` }] }],
    });
    if (res.stop_reason === 'refusal') throw new HttpError(503, 'The reading service declined this page. Please type it in instead.');
    if (res.stop_reason === 'max_tokens') throw new HttpError(502, 'This page has too many entries to read in one go. Split it into two photos.');
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    let parsed: { rows: { fields: Record<string, string>; confidence: Record<string, number>; rawText: string; page: number; box: OcrRow['box'] }[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'The reading service returned something we could not use.');
    }
    return { rows: parsed.rows.map((r) => ({ fields: r.fields, confidence: r.confidence ?? {}, rawText: r.rawText, box: r.box, page: r.page })), fullText: parsed.rows.map((r) => r.rawText).join('\n') };
  }
}

/** Second adapter: Google Cloud Vision text detection, then a line parser. Needs GOOGLE_VISION_API_KEY. */
export class GoogleVisionOcrProvider implements OcrProvider {
  readonly name = 'google-vision';

  async extract({ data, mime, recordType, language }: OcrInput): Promise<OcrResult> {
    const key = process.env.GOOGLE_VISION_API_KEY;
    if (!key) throw new HttpError(503, 'Google Vision is not configured');
    if (mime === 'application/pdf') throw new HttpError(400, 'Send PDF pages as images for this reader');
    const hint = language.toLowerCase().startsWith('yo') ? ['yo', 'en'] : ['en'];
    const { data: res } = await axios.post(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
      requests: [{ image: { content: data.toString('base64') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: { languageHints: hint } }],
    });
    const text: string = res.responses?.[0]?.fullTextAnnotation?.text ?? '';
    return { rows: parseLedgerText(text, recordType), fullText: text };
  }
}

/** Reads loose lines like "Mama Bisi  14/03/2023  5,000" into rows. Low confidence by design: a line parser is guessing. */
export function parseLedgerText(text: string, recordType: RecordType): OcrRow[] {
  const rows: OcrRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length < 4) continue;
    const date = t.match(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/)?.[0];
    // Take the date out first, or its year would be read as an amount.
    const rest = date ? t.replace(date, ' ') : t;
    const amount = rest.match(/(?:₦|N|NGN)?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?:₦|N|NGN)\s?\d+(?:\.\d+)?|\b\d{3,7}(?:\.\d+)?k?\b/i)?.[0];
    const name = rest.replace(amount ?? '', ' ').replace(/[₦\d|_:;,]+/g, ' ').replace(/\bNGN\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!name || (!amount && recordType !== 'MEMBERS')) continue;
    const fields: Record<string, string> = { name };
    const confidence: Record<string, number> = { name: 0.6 };
    if (amount) { fields.amount = amount; confidence.amount = 0.6; }
    if (date) { fields.date = date; confidence.date = 0.6; }
    rows.push({ fields, confidence, rawText: t });
  }
  return rows;
}

/** For tests and for running without any reading service. Returns whatever rows it was given. */
export class StubOcrProvider implements OcrProvider {
  readonly name = 'stub';
  constructor(private rows: OcrRow[] = []) {}
  async extract(): Promise<OcrResult> {
    return { rows: this.rows, fullText: this.rows.map((r) => r.rawText).join('\n') };
  }
}

let override: OcrProvider | null = null;
export const setOcrProvider = (p: OcrProvider | null) => { override = p; };

/** Primary: the vision model. Falls back to Google Vision when only that is configured. With neither, OCR is unavailable and typing/spreadsheets still work. */
export function getOcrProvider(): OcrProvider {
  if (override) return override;
  if (process.env.OCR_PROVIDER === 'google' && process.env.GOOGLE_VISION_API_KEY) return new GoogleVisionOcrProvider();
  if (process.env.ANTHROPIC_API_KEY) return new VisionModelOcrProvider();
  if (process.env.GOOGLE_VISION_API_KEY) return new GoogleVisionOcrProvider();
  throw new HttpError(503, 'Reading scanned pages is not set up yet. You can still type the records or upload a spreadsheet.');
}

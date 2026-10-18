import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../../lib/errors';

// A translation here is only ever a convenience for understanding. It is never the signed text.

export interface TranslationProvider {
  readonly name: string;
  /** Translates a whole markdown document. Keeps headings, lists and the [DRAFT …] line. */
  translateDocument(markdown: string, target: { code: string; label: string }): Promise<string>;
  /** Translates the values of a flat/nested JSON object of interface strings, keeping keys and array order. */
  translateStrings(strings: Record<string, unknown>, target: { code: string; label: string }): Promise<Record<string, unknown>>;
}

const MODEL = 'claude-opus-5-5';

const DOC_SYSTEM = [
  'You translate a short consent document for a community savings app into the requested language.',
  'The reader may have low literacy: use short sentences and everyday words, never legal jargon.',
  'Translate faithfully. Do not add, remove, soften or strengthen any statement, and do not add legal advice or citations.',
  'Keep the markdown structure, the numbering, product names (CC-ÀJỌ, ÀJỌ) and any line in square brackets such as [DRAFT - ...] translated but present.',
  'Return only the translated document, with no preface and no notes.',
].join(' ');

const STRINGS_SYSTEM = [
  'You translate user-interface strings for a community savings app into the requested language, for readers with low literacy.',
  'You receive a JSON object. Return ONLY a JSON object with exactly the same keys and the same array lengths and order, with every string value translated.',
  'Keep product names (CC-ÀJỌ, ÀJỌ) and placeholders like {name} unchanged. No commentary.',
].join(' ');

/** Real provider: the Anthropic Messages API. Needs ANTHROPIC_API_KEY. */
export class AnthropicTranslationProvider implements TranslationProvider {
  readonly name = 'anthropic';
  private client = new Anthropic();

  private async ask(system: string, user: string): Promise<string> {
    // Server-side fallback is on by default for this model: if a safety classifier declines, the same request is re-run on a fallback model.
    const res = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') throw new HttpError(503, 'The translation service declined this text. Please use a witness.');
    if (res.stop_reason === 'max_tokens') throw new HttpError(502, 'The translation was cut off. Please try again.');
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new HttpError(502, 'The translation service returned nothing.');
    return text;
  }

  translateDocument(markdown: string, target: { code: string; label: string }) {
    return this.ask(DOC_SYSTEM, `Target language: ${target.label} (BCP-47: ${target.code}).\n\n<document>\n${markdown}\n</document>`);
  }

  async translateStrings(strings: Record<string, unknown>, target: { code: string; label: string }) {
    const out = await this.ask(STRINGS_SYSTEM, `Target language: ${target.label} (BCP-47: ${target.code}).\n\n${JSON.stringify(strings)}`);
    const json = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new HttpError(502, 'The translation service returned something we could not read.');
    }
    if (!sameShape(strings, parsed)) throw new HttpError(502, 'The translation did not keep the same structure.');
    return parsed as Record<string, unknown>;
  }
}

/** Used when no API key is configured: translation is unavailable, so the flow falls back to witness-assisted signing. */
export class UnavailableTranslationProvider implements TranslationProvider {
  readonly name = 'unavailable';
  translateDocument(): Promise<string> {
    throw new HttpError(503, 'Machine translation is not available right now. Ask a witness to read it to you.');
  }
  translateStrings(): Promise<Record<string, unknown>> {
    throw new HttpError(503, 'Machine translation is not available right now.');
  }
}

/** A translated object must keep every key, and arrays their length. Guards against the model dropping a question. */
export function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a === 'string') return typeof b === 'string' && b.trim().length > 0;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameShape(x, b[i]));
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    return ka.length === Object.keys(b as object).length && ka.every((k) => k in (b as object) && sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return true;
}

let override: TranslationProvider | null = null;
/** Tests (and future providers) can swap the implementation. */
export function setTranslationProvider(p: TranslationProvider | null) { override = p; }
export function getTranslationProvider(): TranslationProvider {
  if (override) return override;
  return process.env.ANTHROPIC_API_KEY ? new AnthropicTranslationProvider() : new UnavailableTranslationProvider();
}

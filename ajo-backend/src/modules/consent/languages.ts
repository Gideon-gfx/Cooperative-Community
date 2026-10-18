// Language handling for consent. ANY language is allowed: pick from this list, or type your own.

export interface Lang { code: string; name: string; native: string }

export const SUPPORTED_LANGUAGES: Lang[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'en-x-plain', name: 'English (plain language)', native: 'Plain English' },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá' },
  { code: 'guw', name: 'Egun (Gun)', native: 'Gungbe / Egun' },
  { code: 'pcm', name: 'Nigerian Pidgin', native: 'Naijá' },
  { code: 'ha', name: 'Hausa', native: 'Hausa' },
  { code: 'ig', name: 'Igbo', native: 'Igbo' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'ee', name: 'Ewe', native: 'Eʋegbe' },
  { code: 'ak', name: 'Twi (Akan)', native: 'Twi' },
  { code: 'ff', name: 'Fulfulde', native: 'Fulfulde' },
  { code: 'kr', name: 'Kanuri', native: 'Kanuri' },
  { code: 'ibb', name: 'Ibibio', native: 'Ibibio' },
  { code: 'efi', name: 'Efik', native: 'Efik' },
  { code: 'tiv', name: 'Tiv', native: 'Tiv' },
  { code: 'bin', name: 'Edo (Bini)', native: 'Ẹ̀dó' },
  { code: 'ijc', name: 'Ijaw', native: 'Ịjọ' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
  { code: 'am', name: 'Amharic', native: 'አማርኛ' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'zu', name: 'Zulu', native: 'isiZulu' },
  { code: 'xh', name: 'Xhosa', native: 'isiXhosa' },
  { code: 'sn', name: 'Shona', native: 'chiShona' },
  { code: 'rw', name: 'Kinyarwanda', native: 'Kinyarwanda' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'zh', name: 'Chinese', native: '中文' },
];

/** Order in which human review is commissioned (translator + independent back-translation + lawyer check). */
export const HUMAN_REVIEW_PRIORITY = ['yo', 'guw', 'pcm', 'en-x-plain', 'ha', 'ig', 'fr'];

/** Low-resource languages where machine translation is weak: always recommend a witness. */
export const WITNESS_RECOMMENDED = new Set(['guw', 'x-egun', 'x-gun', 'x-egungbe']);

/** Languages the client can usually read aloud with on-device text-to-speech. Others fall back to witness-assisted signing. */
export const TTS_LIKELY = new Set(['en', 'en-x-plain', 'fr', 'ha', 'yo', 'sw', 'ar', 'pt', 'es', 'zh', 'hi', 'bn', 'ur', 'am', 'zu', 'xh']);

export const BASE_LANGUAGE = 'en';
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface ResolvedLanguage { code: string; label: string; custom: boolean }

/**
 * Accepts a BCP-47 code from the list, any other well-formed code, or free text ("my language is not listed").
 * Free text becomes a private-use subtag (x-ebira) so it can be cached and reviewed later.
 */
export function resolveLanguage(code: string | undefined, label?: string): ResolvedLanguage {
  const raw = (code ?? '').trim();
  const known = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === raw.toLowerCase());
  if (known) return { code: known.code, label: known.name, custom: false };
  if (raw && BCP47.test(raw) && !raw.startsWith('x-')) return { code: raw.toLowerCase(), label: label?.trim() || raw, custom: false };
  const text = (label ?? raw).trim();
  if (text.length < 2) throw new Error('Tell us which language you want');
  const slug = text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 30);
  return { code: `x-${slug || 'custom'}`, label: text.slice(0, 60), custom: true };
}

export const isOriginalLanguage = (code: string) => code === BASE_LANGUAGE;

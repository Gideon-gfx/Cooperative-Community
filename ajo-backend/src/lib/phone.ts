export interface Country { code: string; dial: string; currency: string; name: string; re: RegExp }

/** Supported countries. `re` matches the national number after the dial code, without a leading 0. */
export const COUNTRIES: Record<string, Country> = {
  NG: { code: 'NG', dial: '234', currency: 'NGN', name: 'Nigeria', re: /^[789][01]\d{8}$/ },
  GH: { code: 'GH', dial: '233', currency: 'GHS', name: 'Ghana', re: /^[235]\d{8}$/ },
  KE: { code: 'KE', dial: '254', currency: 'KES', name: 'Kenya', re: /^[17]\d{8}$/ },
};

/** Normalises a local (0XXXXXXXXX) or international number to E.164 (+234…). Returns null if invalid. */
export function normalizePhone(input: string, country = 'NG'): string | null {
  const c = COUNTRIES[country];
  if (!c) return null;
  const cleaned = input.replace(/[\s()-]/g, '');
  const m = cleaned.match(new RegExp(`^(?:\\+?${c.dial}|0)(\\d+)$`));
  if (m && c.re.test(m[1])) return `+${c.dial}${m[1]}`;
  // The app shows the country code in front of the box, so people type just 803 123 4567 (no 0, no code).
  return /^\d+$/.test(cleaned) && c.re.test(cleaned) ? `+${c.dial}${cleaned}` : null;
}

/** Back-compat helper for Nigeria. */
export const normalizeNigerianPhone = (input: string) => normalizePhone(input, 'NG');

/** Detects the country from an E.164 number. */
export function countryOfPhone(e164: string): string {
  return Object.values(COUNTRIES).find((c) => e164.startsWith(`+${c.dial}`))?.code ?? 'NG';
}

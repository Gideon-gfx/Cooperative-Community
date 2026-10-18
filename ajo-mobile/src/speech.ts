import * as Speech from 'expo-speech';
import type { Lang } from './i18n';

// Pidgin has no voice of its own, so it is read with an English (Nigeria) voice.
const BCP47: Record<Lang, string> = { EN: 'en-NG', PCM: 'en-NG', YO: 'yo-NG', HA: 'ha-NG', IG: 'ig-NG' };
let voices: string[] | null = null;

async function pickLanguage(lang: Lang): Promise<string> {
  if (!voices) {
    try {
      voices = (await Speech.getAvailableVoicesAsync()).map((v) => v.language.replace('_', '-').toLowerCase());
    } catch {
      voices = [];
    }
  }
  const want = BCP47[lang];
  if (voices.includes(want.toLowerCase())) return want;
  const base = want.split('-')[0];
  if (voices.some((v) => v.startsWith(base))) return base;
  return 'en'; // the phone has no voice for this language: fall back to English rather than staying silent
}

/** Reads text aloud for users who find reading hard. Tapping again stops it. */
export async function speak(text: string, lang: Lang = 'EN') {
  if (await Speech.isSpeakingAsync()) {
    Speech.stop();
    return;
  }
  Speech.speak(text, { language: await pickLanguage(lang), rate: 0.9 });
}
export const stopSpeaking = () => Speech.stop();

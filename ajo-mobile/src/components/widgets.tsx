import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View, type KeyboardTypeOptions, type TextInputProps } from 'react-native';
import { useRouter } from 'expo-router';
import { Alert } from './feedback';
import { isPinRequired } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useOutboxCount } from '../offline';
import { noticeFor, type FundsMode } from '../constants';
import { speak } from '../speech';
import { colors, TAP } from '../theme';
import { Button, Sheet, s } from './ui';

export function Field({ label, value, onChangeText, placeholder, keyboardType, secure, multiline, maxLength, editable = true, autoCapitalize = 'none' }: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; keyboardType?: KeyboardTypeOptions;
  secure?: boolean; multiline?: boolean; maxLength?: number; editable?: boolean; autoCapitalize?: TextInputProps['autoCapitalize'];
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={[s.body, { fontWeight: '600' }]}>{label}</Text>
      <TextInput
        style={[s.input, multiline && { minHeight: 90, textAlignVertical: 'top', paddingTop: 10 }, !editable && { backgroundColor: '#F3F4F6' }]}
        value={value} onChangeText={onChangeText} placeholder={placeholder} keyboardType={keyboardType} secureTextEntry={secure}
        multiline={multiline} maxLength={maxLength} editable={editable} autoCapitalize={autoCapitalize}
      />
    </View>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} style={{ minHeight: TAP, paddingHorizontal: 16, borderRadius: 12, borderWidth: 2, justifyContent: 'center', borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primaryLight : colors.white }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: on ? colors.primary : colors.text }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Reminder, on every payment screen, of who holds the money in this group. Falls back to the custody wording if the mode is unknown. */
export function LedgerNotice({ mode }: { mode?: FundsMode }) {
  return (
    <View style={{ backgroundColor: colors.accentLight, borderRadius: 12, borderWidth: 1, borderColor: colors.accent, padding: 10 }}>
      <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>ℹ️ {noticeFor(mode)}</Text>
    </View>
  );
}

/** "Escrow" in green, "Collector-held" in amber: on every group, contribution and receipt screen. */
export function ModeBadge({ mode }: { mode?: FundsMode }) {
  const { t } = useAuth();
  if (!mode) return null;
  const escrow = mode === 'ESCROW';
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: escrow ? '#DCFCE7' : colors.accentLight, borderColor: escrow ? colors.green : colors.accent, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Text style={{ color: escrow ? '#166534' : '#92400E', fontWeight: '700', fontSize: 12 }}>{escrow ? `🛡️ ${t('ib_modeEscrow')}` : `🤝 ${t('ib_modeCustody')}`}</Text>
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <View style={[s.row, { marginTop: 6 }]}><Text style={s.h2}>{children}</Text>{right}</View>;
}

/** 🔊 button: reads a sentence aloud in the user's language (for people who find reading hard). */
export function ReadAloud({ text }: { text: string }) {
  const { lang, t } = useAuth();
  return (
    <Pressable onPress={() => speak(text, lang)} accessibilityLabel={t('readAloud')} style={{ minWidth: TAP, minHeight: TAP, borderRadius: 24, backgroundColor: colors.accentLight, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 24 }}>🔊</Text>
    </Pressable>
  );
}

const TRUST_STYLE: Record<string, [string, string, string]> = {
  GOOD: ['#DCFCE7', '#166534', '⭐ Reliable'],
  FAIR: ['#FEF9C3', '#854D0E', 'Fair record'],
  RISKY: ['#FEE2E2', '#B91C1C', '⚠️ Risky'],
  NEW: ['#E5E7EB', '#374151', 'New'],
};
export interface Trust { score: number; onTimePct: number; label: 'NEW' | 'GOOD' | 'FAIR' | 'RISKY'; verified: number; late: number; missed: number }
export function TrustBadge({ trust, compact }: { trust?: Trust; compact?: boolean }) {
  if (!trust) return null;
  const [bg, fg, text] = TRUST_STYLE[trust.label];
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Text style={{ color: fg, fontWeight: '700', fontSize: 13 }}>{text}{!compact && trust.label !== 'NEW' ? ` · ${trust.onTimePct}% on time` : ''}</Text>
    </View>
  );
}

/** Shown while there are actions waiting to be sent because the phone was offline. */
export function OfflineBanner() {
  const n = useOutboxCount();
  const { t } = useAuth();
  if (!n) return null;
  return <View style={{ backgroundColor: colors.accent, padding: 8 }}><Text style={{ textAlign: 'center', fontWeight: '700' }}>{t('offline', { n })}</Text></View>;
}

/**
 * Promise-based PIN prompt: `const { ask, element } = usePinPrompt()` … `const pin = await ask()` (null if cancelled).
 * Render `{element}` somewhere in the screen.
 */
export function usePinPrompt() {
  const { t } = useAuth();
  const [visible, setVisible] = useState(false);
  const [pin, setPin] = useState('');
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const ask = useCallback(() => new Promise<string | null>((resolve) => {
    resolver.current = resolve;
    setPin('');
    setVisible(true);
  }), []);
  const finish = (v: string | null) => { setVisible(false); resolver.current?.(v); resolver.current = null; };

  const element = (
    <Sheet title={t('enterPin')} visible={visible} onClose={() => finish(null)}>
      <View style={{ gap: 12 }}>
        <TextInput
          autoFocus secureTextEntry keyboardType="number-pad" maxLength={4} value={pin} onChangeText={setPin}
          style={[s.input, { textAlign: 'center', fontSize: 30, letterSpacing: 14 }]} placeholder="••••"
        />
        <Button title={t('continue')} disabled={pin.length !== 4} onPress={() => finish(pin)} />
      </View>
    </Sheet>
  );
  return { ask, element };
}

/** Handles a failed PIN-protected call: if the user has no PIN yet, offers to go set one. */
export function usePinRequiredHandler() {
  const router = useRouter();
  return (e: unknown): boolean => {
    if (!isPinRequired(e)) return false;
    Alert.alert('Set a PIN first', 'For your safety this action needs a 4-digit PIN.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Set PIN', onPress: () => router.push('/settings') },
    ]);
    return true;
  };
}

/** A tap-to-open list for choosing one option: replaces rows of buttons on forms. */
export function Dropdown<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View style={{ gap: 4 }}>
      <Text style={[s.body, { fontWeight: '600' }]}>{label}</Text>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={[s.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
        <Text style={s.body}>{current?.label ?? ''}</Text>
        <Text style={s.body}>▾</Text>
      </Pressable>
      {/* A fade, not a slide: the dimmed backdrop stays still and only the list appears, so nothing jumps. */}
      <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: colors.white, borderRadius: 16, padding: 8, maxHeight: '70%' }}>
            <Text style={[s.h3, { padding: 12 }]}>{label}</Text>
            <ScrollView>
              {options.map((o) => (
                <Pressable key={o.value} onPress={() => { onChange(o.value); setOpen(false); }} style={{ minHeight: TAP, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: o.value === value ? colors.primaryLight : 'transparent' }}>
                  <Text style={[s.body, o.value === value && { fontWeight: '700', color: colors.primary }]}>{o.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Phone input with the country code always shown in front of it. */
export function PhoneField({ label, dial, value, onChangeText, placeholder }: { label: string; dial: string; value: string; onChangeText: (v: string) => void; placeholder?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={[s.body, { fontWeight: '600' }]}>{label}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={[s.input, { justifyContent: 'center', backgroundColor: '#F3F4F6' }]}><Text style={[s.body, { fontWeight: '700' }]}>{dial}</Text></View>
        <TextInput style={[s.input, { flex: 1 }]} value={value} onChangeText={onChangeText} keyboardType="phone-pad" placeholder={placeholder} autoCapitalize="none" />
      </View>
    </View>
  );
}

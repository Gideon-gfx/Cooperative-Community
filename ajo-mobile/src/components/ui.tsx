import { createContext, useContext, useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal as RNModal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { colors, fonts, TAP } from '../theme';
import { useLoader } from './GlobalLoader';
export { DotsLoader } from './DotsLoader';

type Variant = 'primary' | 'accent' | 'outline' | 'danger';
const BG: Record<Variant, string> = { primary: colors.zobo, accent: colors.gold, outline: 'transparent', danger: colors.red };
const FG: Record<Variant, string> = { primary: colors.white, accent: colors.text, outline: colors.clay, danger: colors.white };

/** Lets something that needs a finger-drag (like the signature pad) freeze the page's scrolling while it is being drawn on. */
export const ScrollLockContext = createContext<(locked: boolean) => void>(() => undefined);

/** Inside a Screen marked `loaderButtons`, every Button shows the app-wide blurred loader while its action runs. */
const ButtonLoaderScope = createContext(false);

export function Button({ title, onPress, variant = 'primary', disabled, loading, style }: {
  title: string; onPress: () => void | Promise<unknown>; variant?: Variant; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const withLoader = useLoader();
  const scoped = useContext(ButtonLoaderScope);
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => { if (scoped) void withLoader(async () => { await onPress(); }); else void onPress(); }}
      disabled={off}
      style={[s.btn, { backgroundColor: BG[variant], borderColor: variant === 'outline' ? colors.clay : BG[variant], opacity: off ? 0.5 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={FG[variant]} /> : <Text style={[s.btnText, { color: FG[variant] }]}>{title}</Text>}
    </Pressable>
  );
}

/** A tappable text link. Tapping it shows the app-wide blurred loader (at least two seconds, longer on a slow connection) and ignores repeat taps. */
export function LinkText({ children, onPress, style, underline, align = 'center', compact = false }: { children: ReactNode; onPress: () => void | Promise<unknown>; style?: StyleProp<TextStyle>; underline?: boolean; align?: 'left' | 'center' | 'right'; compact?: boolean }) {
  const withLoader = useLoader();
  return (
    <Pressable accessibilityRole="link" onPress={() => { void withLoader(async () => { await onPress(); }); }} style={{ minHeight: compact ? 24 : TAP, width: '100%', justifyContent: 'center', alignItems: align === 'right' ? 'flex-end' : align === 'left' ? 'flex-start' : 'center', flexDirection: 'row', gap: 8 }}>
      <Text style={[{ color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 16, textDecorationLine: underline ? 'underline' : 'none' }, style]}>{children}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

const BADGE: Record<string, [string, string]> = {
  CLEAN: ['#DCFCE7', '#166534'], WARNED: ['#FEF9C3', '#854D0E'], DEFAULTER: ['#FEE2E2', '#B91C1C'],
  COMPLETED: ['#DCFCE7', '#166534'], VERIFIED: ['#DCFCE7', '#166534'], DELIVERED: ['#DCFCE7', '#166534'], ACTIVE: ['#DCFCE7', '#166534'],
  SCHEDULED: ['#F3F4F6', '#374151'], PENDING: ['#FEF9C3', '#854D0E'], PROCESSING: ['#DBEAFE', '#1E40AF'], COLLECTING: ['#DBEAFE', '#1E40AF'],
  LOCKED: [colors.accentLight, '#92400E'], DISPATCHED: [colors.accentLight, '#92400E'],
  MISSED: ['#FEE2E2', '#B91C1C'], FAILED: ['#FEE2E2', '#B91C1C'], DISSOLVED: ['#FEE2E2', '#B91C1C'], LATE: ['#FFEDD5', '#9A3412'],
};
export const STATUS_EMOJI: Record<string, string> = { CLEAN: '🟢', WARNED: '🟡', DEFAULTER: '🔴' };

export function StatusBadge({ status }: { status: string }) {
  const [bg, fg] = BADGE[status] ?? ['#F3F4F6', '#374151'];
  return <View style={[s.badge, { backgroundColor: bg }]}><Text style={{ color: fg, fontWeight: '700', fontSize: 13 }}>{status}</Text></View>;
}

export function ProgressBar({ value, max, color = colors.orange }: { value: number; max: number; color?: string }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return <View style={s.track}><View style={{ width: `${pct}%`, height: '100%', backgroundColor: color }} /></View>;
}

export function Screen({ children, scroll = true, padded = true, loaderButtons = false, keyboardAvoiding = false, refreshable = true }: { children: ReactNode; scroll?: boolean; padded?: boolean; loaderButtons?: boolean; keyboardAvoiding?: boolean; refreshable?: boolean }) {
  const inner = padded ? { padding: 16, gap: 14 } : undefined;
  const [locked, setLocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const withLoader = useLoader();
  const refresh = async () => {
    setRefreshing(true);
    try {
      await withLoader(() => queryClient.invalidateQueries({ type: 'active' }));
    } finally {
      setRefreshing(false);
    }
  };
  const content = scroll
    ? <ScrollView
        contentContainerStyle={[inner, keyboardAvoiding ? { flexGrow: 1 } : undefined]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        scrollEnabled={!locked}
        refreshControl={refreshable ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined}
      >
        {children}
      </ScrollView>
    : <View style={[{ flex: 1 }, inner]}>{children}</View>;
  return (
    <ScrollLockContext.Provider value={setLocked}>
    <ButtonLoaderScope.Provider value={loaderButtons}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom', 'left', 'right']}>
      {keyboardAvoiding
        ? <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>{content}</KeyboardAvoidingView>
        : content}
    </SafeAreaView>
    </ButtonLoaderScope.Provider>
    </ScrollLockContext.Provider>
  );
}

export function Loading() {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" color={colors.primary} /></View>;
}

export function Sheet({ title, visible, onClose, children }: { title: string; visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <RNModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={s.h2}>{title}</Text>
            <Pressable onPress={onClose} style={{ minWidth: TAP, minHeight: TAP, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Close"><Text style={{ fontSize: 22 }}>✕</Text></Pressable>
          </View>
          {children}
        </Pressable>
      </Pressable>
    </RNModal>
  );
}

export const s = StyleSheet.create({
  btn: { minHeight: TAP, minWidth: TAP, borderRadius: 12, borderWidth: 2, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 17, fontFamily: fonts.bodyBold },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, borderWidth: 1.5, borderColor: colors.cocoa, gap: 6, shadowColor: colors.cocoa, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 1, shadowRadius: 0, elevation: 3 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  track: { height: 12, borderRadius: 6, backgroundColor: '#F0E2CC', overflow: 'hidden' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 },
  h1: { fontSize: 24, fontFamily: fonts.displayHeavy, color: colors.text },
  h2: { fontSize: 20, fontFamily: fonts.display, color: colors.text },
  h3: { fontSize: 16, fontFamily: fonts.display, color: colors.text },
  body: { fontSize: 17, fontFamily: fonts.body, color: colors.text },
  muted: { fontSize: 15, fontFamily: fonts.body, color: colors.muted },
  money: { fontFamily: fonts.mono, color: colors.text },
  input: { minHeight: TAP, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, fontFamily: fonts.body, backgroundColor: colors.white },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
});

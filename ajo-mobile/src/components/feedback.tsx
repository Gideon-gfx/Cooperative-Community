import { useEffect, useSyncExternalStore } from 'react';
import { Alert as NativeAlert, Pressable, Text, View, type AlertButton, type AlertOptions } from 'react-native';
import { colors, fonts } from '../theme';

type Tone = 'success' | 'error' | 'info';
type Notice = { id: number; title: string; message?: string; tone: Tone };

let notice: Notice | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function publish() {
  listeners.forEach((listener) => listener());
}

function toneFor(title: string): Tone {
  const lower = title.toLowerCase();
  if (/error|failed|could not|wrong|invalid|needed|denied|not match|must|unable|required|cannot/.test(lower)) return 'error';
  if (/saved|created|done|verified|approved|submitted|sent|success|complete|copied/.test(lower)) return 'success';
  return 'info';
}

function showNotice(title: string, message?: string) {
  notice = { id: ++nextId, title, message, tone: toneFor(title) };
  publish();
}

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) {
    if (buttons?.length) {
      NativeAlert.alert(title, message, buttons, options);
      return;
    }
    showNotice(title, message);
  },
};

export function FeedbackHost() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notice,
    () => null,
  );

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => {
      if (notice?.id === current.id) {
        notice = null;
        publish();
      }
    }, 4200);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current) return null;
  const accent = current.tone === 'success' ? colors.green : current.tone === 'error' ? colors.red : colors.primary;
  const label = current.tone === 'success' ? 'SUCCESS' : current.tone === 'error' ? 'ERROR' : 'NOTICE';

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 48, left: 16, right: 16, zIndex: 1000, elevation: 1000 }}>
      <View accessibilityRole="alert" style={{ backgroundColor: colors.card, borderColor: accent, borderLeftWidth: 5, borderWidth: 1, borderRadius: 16, padding: 16, shadowColor: colors.cocoa, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 10, elevation: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ color: accent, fontFamily: fonts.bodyBold, fontSize: 12, letterSpacing: 1 }}>{label}</Text>
            <Text style={{ color: colors.text, fontFamily: fonts.bodyBold, fontSize: 16 }}>{current.title}</Text>
            {!!current.message && <Text style={{ color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 }}>{current.message}</Text>}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notification" onPress={() => {
            if (notice?.id === current.id) {
              notice = null;
              publish();
            }
          }} hitSlop={8}>
            <Text style={{ color: colors.muted, fontSize: 20, lineHeight: 24 }}>×</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

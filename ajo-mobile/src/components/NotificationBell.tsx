import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, money } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Sheet, s } from './ui';
import { colors, fonts, TAP } from '../theme';

export interface Notice { kind: 'DUE' | 'MISSED' | 'CONFIRM_PAYOUT' | 'PAYOUT_READY' | 'PAYMENTS_TO_VERIFY'; poolId: string; poolTitle: string; recipientName?: string; amount?: number; currency?: string; dueAt?: string; count?: number }

export const fmt = (d: string | null | undefined) => (d ? format(new Date(d), 'd MMM yyyy') : '—');

export function noticeText(n: Notice): { title: string; body: string; danger?: boolean } {
  switch (n.kind) {
    case 'MISSED': return { title: '⚠️ Missed payment', body: `${money(n.amount!, n.currency)} for ${n.recipientName} · ${n.poolTitle}`, danger: true };
    case 'DUE': return { title: 'Payment due', body: `${money(n.amount!, n.currency)} for ${n.recipientName} · ${n.poolTitle} · ${fmt(n.dueAt)}` };
    case 'CONFIRM_PAYOUT': return { title: '💰 Did you receive your payout?', body: `${n.poolTitle}: please confirm in the pool` };
    case 'PAYOUT_READY': return { title: '✅ Ready to pay out', body: `${n.poolTitle}: pay ${n.recipientName} and record it` };
    default: return { title: '🧾 Payments to confirm', body: `${n.count} waiting in ${n.poolTitle}` };
  }
}


/** The one query behind the bell, the home screen's due-card and the spoken summary. */
export const useNotices = () => useQuery({ queryKey: ['my-ajo'], queryFn: async () => (await api.get<{ pools: unknown[]; notifications: Notice[] }>('/ajo/my-pools')).data });

/** The bell in the top bar of every tab: a red count and a list of what needs you. */
export function NotificationBell() {
  const { t } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const notices = useNotices().data?.notifications ?? [];
  return (
    <View style={{ marginRight: 12 }}>
      <Pressable onPress={() => setOpen(true)} style={{ minWidth: TAP, minHeight: TAP, borderRadius: 24, borderWidth: 2, borderColor: colors.cream, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel={t('notifications')}>
        <Text style={{ fontSize: 22 }}>🔔</Text>
        {notices.length > 0 && <View style={{ position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontFamily: fonts.bodyBold, fontSize: 12 }}>{notices.length}</Text></View>}
      </Pressable>
      <Sheet title={t('notifications')} visible={open} onClose={() => setOpen(false)}>
        {notices.length === 0 && <Text style={s.muted}>{t('caughtUp')}</Text>}
        {notices.map((n, i) => {
          const x = noticeText(n);
          return (
            <Pressable key={i} onPress={() => { setOpen(false); router.push(`/ajo/${n.poolId}`); }} style={{ minHeight: TAP, padding: 12, borderRadius: 12, marginBottom: 8, backgroundColor: x.danger ? '#FDE4E1' : colors.background }}>
              <Text style={[s.body, { fontFamily: fonts.bodyBold, color: x.danger ? colors.red : colors.text }]}>{x.title}</Text>
              <Text style={s.muted}>{x.body}</Text>
            </Pressable>
          );
        })}
      </Sheet>
    </View>
  );
}

import { useState } from 'react';
import { Alert, Share, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, s } from './ui';
import { useLoader } from './GlobalLoader';
import { colors, fonts } from '../theme';

/** "Create my referral code": a personal code to share. Friends type it when they sign up. */
export function ReferralCard() {
  const { t } = useAuth();
  const withLoader = useLoader();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['referral'], queryFn: async () => (await api.get<{ code: string | null; referred: number }>('/auth/referral')).data });
  const code = q.data?.code;

  const create = async () => {
    setBusy(true);
    let failure: unknown;
    try { await withLoader(async () => { try { await api.post('/auth/referral-code'); await q.refetch(); } catch (e) { failure = e; } }); } finally { setBusy(false); }
    if (failure) Alert.alert(t('ib_error'), errMsg(failure));
  };
  const share = () => Share.share({ message: t('ib_refShareMessage', { code: code ?? '' }) }).catch(() => undefined);

  return (
    <Card style={{ backgroundColor: colors.accentLight, borderColor: colors.gold }}>
      <Text style={s.h3}>🎁 {t('ib_refTitle')}</Text>
      <Text style={s.muted}>{t('ib_refHint')}</Text>
      {code ? (
        <View style={{ gap: 8 }}>
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 28, letterSpacing: 2, textAlign: 'center', color: colors.cocoa }}>{code}</Text>
          <Text style={[s.body, { textAlign: 'center' }]}>{t('ib_refCount', { n: q.data?.referred ?? 0 })}</Text>
          <Button title={`📤 ${t('ib_refShare')}`} onPress={share} />
        </View>
      ) : (
        <Button title={t('ib_refCreate')} loading={busy} disabled={q.isLoading} onPress={create} />
      )}
    </Card>
  );
}

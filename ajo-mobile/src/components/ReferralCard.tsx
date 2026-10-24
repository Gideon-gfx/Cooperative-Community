import { useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, s } from './ui';
import { useLoader } from './GlobalLoader';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, gradients } from '../theme';

/** "Create my referral code": a personal code to share. Friends type it when they sign up. */
export function ReferralCard() {
  const { t } = useAuth();
  const withLoader = useLoader();
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareCard = useRef<View>(null);
  const q = useQuery({ queryKey: ['referral'], queryFn: async () => (await api.get<{ code: string | null; referred: number }>('/auth/referral')).data });
  const code = q.data?.code;

  const create = async () => {
    setBusy(true);
    let failure: unknown;
    try { await withLoader(async () => { try { await api.post('/auth/referral-code'); await q.refetch(); } catch (e) { failure = e; } }); } finally { setBusy(false); }
    if (failure) Alert.alert(t('ib_error'), errMsg(failure));
  };
  const share = async () => {
    if (!shareCard.current || !code) return;
    setSharing(true);
    try {
      const uri = await captureRef(shareCard, { format: 'png', quality: 1 });
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
      await Sharing.shareAsync(uri, { dialogTitle: t('ib_refShare'), mimeType: 'image/png', UTI: 'public.png' });
    } catch (error) {
      Alert.alert(t('ib_error'), errMsg(error));
    } finally {
      setSharing(false);
    }
  };

  return (
    <Card style={{ backgroundColor: colors.accentLight, borderColor: colors.gold }}>
      <Text style={s.h3}>🎁 {t('ib_refTitle')}</Text>
      <Text style={s.muted}>{t('ib_refHint')}</Text>
      {code ? (
        <View style={{ gap: 12 }}>
          <View ref={shareCard} collapsable={false} style={{ borderRadius: 20, overflow: 'hidden' }}>
            <LinearGradient colors={[...gradients.zobo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 24, minHeight: 250, justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Text style={{ color: colors.gold, fontFamily: fonts.display, fontSize: 24 }}>ÀJỌ</Text>
                <Text style={{ color: colors.white, fontFamily: fonts.bodyBold, fontSize: 17, textAlign: 'center' }}>Join me on ÀJỌ</Text>
              </View>
              <View style={{ backgroundColor: colors.white, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center', gap: 4 }}>
                <Text style={{ color: colors.muted, fontFamily: fonts.bodyBold, fontSize: 11, letterSpacing: 1 }}>MY REFERRAL CODE</Text>
                <Text selectable style={{ fontFamily: fonts.mono, fontSize: 28, letterSpacing: 2, color: colors.cocoa }}>{code}</Text>
              </View>
              <Text style={{ color: colors.cream, fontFamily: fonts.body, fontSize: 13, textAlign: 'center' }}>Enter this code when you create your account</Text>
            </LinearGradient>
          </View>
          <Text style={[s.body, { textAlign: 'center' }]}>{t('ib_refCount', { n: q.data?.referred ?? 0 })}</Text>
          <Button title={`📤 ${t('ib_refShare')}`} onPress={share} loading={sharing} />
        </View>
      ) : (
        <Button title={t('ib_refCreate')} loading={busy} disabled={q.isLoading} onPress={create} />
      )}
    </Card>
  );
}

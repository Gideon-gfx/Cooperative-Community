import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Button, Card, Loading, Screen, s } from '../../../components/ui';
import { Field, ReadAloud } from '../../../components/widgets';
import { LangToggle, SignaturePad, StatusCard, useRefreshModule, type Contract, type SignaturePadHandle } from '../../../components/igba';

// Sign with a typed name and a drawn signature. The agreement is read aloud on request.
export default function SignAgreement() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, user } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const pad = useRef<SignaturePadHandle>(null);
  const q = useQuery({ queryKey: ['contract', id], queryFn: async () => (await api.get<Contract>(`/contracts/${id}`)).data });
  const [name, setName] = useState(user?.fullName ?? '');
  const [ink, setInk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!q.data) return <Loading />;
  const c = q.data;

  const sign = async () => {
    setBusy(true);
    try {
      const url = await pad.current?.save();
      if (!url) { Alert.alert(t('ib_error'), t('ib_drawFirst')); return; }
      const { data } = await api.post<{ activated?: boolean }>(`/contracts/${id}/sign`, { typedName: name.trim(), signatureImageUrl: url });
      await refresh();
      Alert.alert(t('ib_signed'), data.activated ? t('ib_nowActive') : t('ib_waitingOthers'));
      router.back();
    } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <LangToggle />
      <StatusCard tone="yellow" title={t('ib_readBeforeSigning')} body={`${c.tradeCategory} · ${c.parties.master?.name} → ${c.parties.apprentice?.name}`} speakText={c.termsAndConditions} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={s.h3}>{t('ib_terms')}</Text><ReadAloud text={c.termsAndConditions} /></View>
        <Text style={s.body}>{c.termsAndConditions}</Text>
      </Card>
      <Field label={t('ib_typedName')} value={name} onChangeText={setName} />
      <Text style={s.body}>{t('ib_drawSignature')}</Text>
      <SignaturePad ref={pad} onInk={setInk} />
      <Button title={t('ib_iAgreeSign')} loading={busy} disabled={name.trim().length < 2 || !ink} onPress={sign} />
    </Screen>
  );
}

import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../../components/ui';
import { Chips, Field, SectionTitle } from '../../../components/widgets';
import { FaceRating, LangToggle, StatusCard, useRefreshModule, type Contract } from '../../../components/igba';
import { colors, fonts } from '../../../theme';

const CATS = ['PUNCTUALITY', 'SKILL_PROGRESS', 'HONESTY', 'ATTITUDE', 'SAFETY', 'TEACHING', 'FAIR_TREATMENT', 'WELFARE', 'OTHER'] as const;
// Which categories each side can be rated on (the server decides who is rated from who writes the entry).
const MASTER_RATES = ['PUNCTUALITY', 'SKILL_PROGRESS', 'HONESTY', 'ATTITUDE', 'SAFETY', 'OTHER'];
const APPRENTICE_RATES = ['TEACHING', 'FAIR_TREATMENT', 'WELFARE', 'SAFETY', 'HONESTY', 'OTHER'];
interface Log { id: string; about: 'APPRENTICE' | 'MASTER'; category: string; rating: number; note: string | null; createdAt: string; mine: boolean }
const FACE = ['😠', '🙁', '😐', '🙂', '😄'];

export default function Conduct() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useAuth();
  const refresh = useRefreshModule();
  const contract = useQuery({ queryKey: ['contract', id], queryFn: async () => (await api.get<Contract>(`/contracts/${id}`)).data });
  const logs = useQuery({ queryKey: ['conduct', id], queryFn: async () => (await api.get<{ logs: Log[] }>(`/contracts/${id}/conduct`)).data.logs });
  const [category, setCategory] = useState<(typeof CATS)[number]>('PUNCTUALITY');
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [appeal, setAppeal] = useState<Log | null>(null);
  const [reason, setReason] = useState('');
  if (contract.isLoading || logs.isLoading) return <Loading />;
  const me = contract.data?.myRole;
  const canRate = me === 'MASTER' || me === 'APPRENTICE';
  const allowed = (me === 'MASTER' ? MASTER_RATES : APPRENTICE_RATES) as string[];

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/contracts/${id}/conduct`, { category, rating, ...(note.trim() ? { note: note.trim() } : {}) });
      setRating(0); setNote(''); await refresh(); Alert.alert(t('ib_saved'), t('ib_conductSaved'));
    } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };
  const sendAppeal = async () => {
    setBusy(true);
    try { await api.post('/trust/appeals', { conductLogId: appeal!.id, reason: reason.trim() }); setAppeal(null); setReason(''); Alert.alert(t('ib_sent'), t('ib_appealSent')); }
    catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <LangToggle />
      {canRate && (
        <Card>
          <Text style={s.h3}>{t(me === 'MASTER' ? 'ib_rateApprentice' : 'ib_rateMaster')}</Text>
          <Chips<string> value={category} onChange={(v) => setCategory(v as (typeof CATS)[number])} options={CATS.filter((c) => allowed.includes(c)).map((c) => ({ value: c, label: t(`ib_cat_${c}`) }))} />
          <FaceRating value={rating} onChange={setRating} />
          <Field label={t('ib_noteOptional')} value={note} onChangeText={setNote} multiline maxLength={500} />
          <Button title={t('ib_saveRating')} loading={busy} disabled={rating === 0} onPress={save} />
        </Card>
      )}
      <SectionTitle>{t('ib_history')}</SectionTitle>
      {!logs.data?.length && <StatusCard tone="yellow" title={t('ib_noRatings')} />}
      {logs.data?.map((l) => {
        const aboutMe = (me === 'APPRENTICE' && l.about === 'APPRENTICE') || (me === 'MASTER' && l.about === 'MASTER');
        return (
          <Card key={l.id}>
            <View style={s.row}><Text style={[s.body, { fontFamily: fonts.bodyBold }]}>{t(`ib_cat_${l.category}`)}</Text><Text style={{ fontSize: 28 }}>{FACE[l.rating - 1]}</Text></View>
            <Text style={s.muted}>{t(l.about === 'MASTER' ? 'ib_aboutMaster' : 'ib_aboutApprentice')} · {format(new Date(l.createdAt), 'd MMM yyyy')}</Text>
            {l.note ? <Text style={s.body}>{l.note}</Text> : null}
            {aboutMe && !l.mine && l.rating <= 2 && <Button title={t('ib_appeal')} variant="outline" onPress={() => setAppeal(l)} />}
          </Card>
        );
      })}
      <Sheet title={t('ib_appeal')} visible={!!appeal} onClose={() => setAppeal(null)}>
        <View style={{ gap: 12 }}>
          <Text style={s.muted}>{t('ib_appealHint')}</Text>
          <Field label={t('ib_reason')} value={reason} onChangeText={setReason} multiline maxLength={500} />
          <Button title={t('ib_send')} loading={busy} disabled={reason.trim().length < 10} onPress={sendAppeal} />
        </View>
      </Sheet>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{t('ib_conductPrivate')}</Text>
    </Screen>
  );
}

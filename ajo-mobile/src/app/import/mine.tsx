import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg, naira } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Loading, Screen, Sheet, s } from '../../components/ui';
import { Field } from '../../components/widgets';
import { LangToggle, StatusCard, useRefreshModule } from '../../components/igba';

interface Entry { id: string; date: string; kind: string; amount: number; cycleLabel: string | null; status: string; disputeNote: string | null }

// "Is this what you paid?" Members check what the old records say about them and say yes or no.
export default function MyOldRecords() {
  const { t } = useAuth();
  const refresh = useRefreshModule();
  const q = useQuery({ queryKey: ['records-mine'], queryFn: async () => (await api.get<{ entries: Entry[] }>('/records/mine')).data.entries });
  const [dispute, setDispute] = useState<Entry | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Loading />;
  const send = async (e: Entry, confirm: boolean) => { setBusy(true); try { await api.post(`/records/verify/${e.id}`, { confirm, ...(!confirm && note.trim() ? { note: note.trim() } : {}) }); setDispute(null); setNote(''); await refresh(); await q.refetch(); } catch (x) { Alert.alert(t('ib_error'), errMsg(x)); } finally { setBusy(false); } };
  return (
    <Screen>
      <LangToggle />
      <StatusCard tone="yellow" title={t('ib_myEntriesTitle')} body={t('ib_myEntriesIntro')} speakText={t('ib_myEntriesIntro')} />
      {!q.data?.length && <Text style={s.muted}>{t('ib_none')}</Text>}
      {q.data?.map((e) => (
        <View key={e.id} style={{ gap: 8 }}>
          <StatusCard tone={e.status === 'MEMBER_VERIFIED' ? 'green' : e.status === 'DISPUTED' ? 'red' : 'yellow'} title={`${naira(e.amount)} · ${t(`ib_kind_${e.kind}`)}`} body={`${e.date}${e.cycleLabel ? ` · ${e.cycleLabel}` : ''} · ${t(`ib_ver_${e.status}`)}${e.disputeNote ? `\n💬 ${e.disputeNote}` : ''}`} />
          {e.status !== 'MEMBER_VERIFIED' && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button style={{ flex: 1 }} title={`✅ ${t('ib_yesCorrect')}`} loading={busy} onPress={() => send(e, true)} />
              <Button style={{ flex: 1 }} title={`❌ ${t('ib_notCorrect')}`} variant="danger" onPress={() => setDispute(e)} />
            </View>
          )}
        </View>
      ))}
      <Sheet title={t('ib_notCorrect')} visible={!!dispute} onClose={() => setDispute(null)}>
        <View style={{ gap: 12 }}>
          <Field label={t('ib_whatsWrong')} value={note} onChangeText={setNote} multiline maxLength={300} />
          <Button title={t('ib_send')} loading={busy} onPress={() => (dispute ? send(dispute, false) : undefined)} />
        </View>
      </Sheet>
    </Screen>
  );
}

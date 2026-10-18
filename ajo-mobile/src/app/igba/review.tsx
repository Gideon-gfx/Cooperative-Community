import { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useRouter } from 'expo-router';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../components/ui';
import { Field, SectionTitle } from '../../components/widgets';
import { LangToggle, StatusCard, useMyContracts, useRefreshModule, type Contract, type Milestone } from '../../components/igba';

// The master's review queue: every piece of work the apprentices have handed in, newest agreement first.
export default function ReviewQueue() {
  const { t } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const list = useMyContracts();
  const [open, setOpen] = useState<{ c: Contract; m: Milestone } | null>(null);
  const [note, setNote] = useState('');
  const [badge, setBadge] = useState('');
  const [busy, setBusy] = useState(false);
  if (list.isLoading) return <Loading />;
  const queue = (list.data ?? []).filter((c) => c.myRole === 'MASTER' && c.status === 'ACTIVE').flatMap((c) => c.milestones.filter((m) => m.status === 'SUBMITTED_FOR_REVIEW').map((m) => ({ c, m })));

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.patch(`/contracts/milestones/${open!.m.id}/review`, { approve, ...(note.trim() ? { note: note.trim() } : {}), ...(approve && badge.trim() ? { badgeSkill: badge.trim() } : {}) });
      setOpen(null); setNote(''); setBadge(''); await refresh();
    } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <LangToggle />
      <SectionTitle>{t('ib_reviewQueue')}</SectionTitle>
      {queue.length === 0 && <StatusCard tone="green" title={t('ib_nothingToReview')} body={t('ib_allCaughtUp')} speakText={t('ib_nothingToReview')} />}
      {queue.map(({ c, m }) => (
        <Card key={m.id}>
          <Text style={s.muted}>{c.parties.apprentice?.name} · {c.tradeCategory}</Text>
          <Text style={s.h3}>{m.order}. {m.title}</Text>
          {m.submissionNote ? <Text style={s.body}>{m.submissionNote}</Text> : null}
          {m.evidenceUrl ? <Image source={{ uri: m.evidenceUrl }} style={{ width: '100%', height: 180, borderRadius: 12 }} resizeMode="cover" /> : null}
          <Button title={t('ib_reviewNow')} onPress={() => setOpen({ c, m })} />
          <Button title={t('ib_openAgreement')} variant="outline" onPress={() => router.push(`/igba/${c.id}`)} />
        </Card>
      ))}
      <Sheet title={open?.m.title ?? ''} visible={!!open} onClose={() => setOpen(null)}>
        <View style={{ gap: 12 }}>
          <Field label={t('ib_noteOptional')} value={note} onChangeText={setNote} multiline maxLength={500} />
          <Field label={t('ib_badgeSkill')} value={badge} onChangeText={setBadge} placeholder={t('ib_badgeHint')} maxLength={60} />
          <Button title={`✅ ${t('ib_approve')}`} loading={busy} onPress={() => decide(true)} />
          <Button title={`↩️ ${t('ib_sendBack')}`} variant="danger" loading={busy} disabled={note.trim().length < 3} onPress={() => decide(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}

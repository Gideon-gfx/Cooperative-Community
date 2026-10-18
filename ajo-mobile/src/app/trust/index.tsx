import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg, naira } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../components/ui';
import { Field, SectionTitle } from '../../components/widgets';
import { LangToggle, StatusCard, useRefreshModule } from '../../components/igba';
import { colors, fonts } from '../../theme';

interface Release { id: string; contractId: string; status: string; amount: number | null; accountName: string | null; nameMismatch: boolean; approvals: number; approvalsRequired: number; rejections: number; iVoted: boolean }
interface Board {
  pendingMasters: { userId: string; name: string; tradeCategories: string[] }[];
  pausedOrEnded: { id: string; status: string; reason: string | null; tradeCategory: string }[];
  releaseApprovals: Release[];
  missedContributions: { contractId: string; number: number; dueDate: string; amount: number }[];
  disputedPayments: { id: string; amount: string; note: string | null; mode: string }[];
  appeals: { id: string; contractId: string; reason: string }[];
  guarantorsToVerify: { userId: string; name: string }[];
}
type Ask = { kind: 'release'; r: Release } | { kind: 'appeal'; id: string; reason: string } | { kind: 'master'; userId: string; name: string } | null;

// Trust Board: everything that is waiting on a decision, in one place. Every action needs a person and leaves a record.
export default function TrustBoard() {
  const { t } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const q = useQuery({ queryKey: ['trust-board'], queryFn: async () => (await api.get<Board>('/trust/dashboard')).data });
  const [ask, setAsk] = useState<Ask>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (q.isLoading || !q.data) return <Loading />;
  const b = q.data;
  const total = b.pendingMasters.length + b.releaseApprovals.filter((r) => !r.iVoted).length + b.appeals.length + b.guarantorsToVerify.length;

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setAsk(null); setNote(''); await refresh(); await q.refetch(); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); } };
  const decide = (yes: boolean) => {
    if (!ask) return;
    if (ask.kind === 'release') return act(() => api.post(`/settlement/releases/${ask.r.id}/approve`, { approve: yes, ...(note.trim() ? { note: note.trim() } : {}) }));
    if (ask.kind === 'appeal') return act(() => api.post(`/trust/appeals/${ask.id}/resolve`, { uphold: yes, note: note.trim() }));
    return act(() => api.patch(`/contracts/masters/${ask.userId}/decision`, { approve: yes, ...(note.trim() ? { note: note.trim() } : {}) }));
  };
  const needNote = ask?.kind === 'appeal';

  return (
    <Screen>
      <LangToggle />
      <StatusCard tone={total === 0 ? 'green' : 'yellow'} title={total === 0 ? t('ib_boardClear') : t('ib_boardWaiting', { n: total })} body={t('ib_boardIntro')} speakText={total === 0 ? t('ib_boardClear') : t('ib_boardWaiting', { n: total })} />

      <Button title={t('ib_manageBoards')} variant="outline" onPress={() => router.push('/trust/boards')} />

      <SectionTitle>{t('ib_releasesTitle')}</SectionTitle>
      {b.releaseApprovals.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.releaseApprovals.map((r) => (
        <Card key={r.id}>
          <Text style={s.money}>{r.amount !== null ? naira(r.amount) : '—'}</Text>
          <Text style={s.body}>{r.accountName ?? '—'}</Text>
          {r.nameMismatch && <Text style={{ color: colors.red, fontFamily: fonts.bodyBold }}>{t('ib_nameDiffersWarn')}</Text>}
          <Text style={s.muted}>{t('ib_approvalsOf', { n: r.approvals, total: r.approvalsRequired })}</Text>
          {r.iVoted ? <Text style={s.muted}>✅ {t('ib_youVoted')}</Text> : <Button title={t('ib_decide')} onPress={() => setAsk({ kind: 'release', r })} />}
        </Card>
      ))}

      <SectionTitle>{t('ib_mastersTitle')}</SectionTitle>
      {b.pendingMasters.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.pendingMasters.map((m) => (
        <Card key={m.userId}><Text style={s.h3}>{m.name}</Text><Text style={s.muted}>{m.tradeCategories.join(', ')}</Text><Button title={t('ib_decide')} onPress={() => setAsk({ kind: 'master', userId: m.userId, name: m.name })} /></Card>
      ))}

      <SectionTitle>{t('ib_appealsTitle')}</SectionTitle>
      {b.appeals.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.appeals.map((a) => <Card key={a.id}><Text style={s.body}>{a.reason}</Text><Button title={t('ib_decide')} onPress={() => setAsk({ kind: 'appeal', id: a.id, reason: a.reason })} /></Card>)}

      <SectionTitle>{t('ib_guarantorsTitle')}</SectionTitle>
      {b.guarantorsToVerify.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.guarantorsToVerify.map((g) => <Card key={g.userId}><Text style={s.h3}>{g.name}</Text><Text style={s.muted}>{t('ib_guarantorVerifyHint')}</Text><Button title={`✅ ${t('ib_verify')}`} loading={busy} onPress={() => act(() => api.post(`/trust/guarantors/${g.userId}/verify`))} /></Card>)}

      <SectionTitle>{t('ib_stoppedTitle')}</SectionTitle>
      {b.pausedOrEnded.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.pausedOrEnded.map((c) => <StatusCard key={c.id} tone={c.status === 'TERMINATED' ? 'red' : 'yellow'} title={`${c.tradeCategory} · ${t(`ib_status_${c.status}`)}`} body={c.reason ?? undefined} />)}

      <SectionTitle>{t('ib_missedTitle')}</SectionTitle>
      {b.missedContributions.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.missedContributions.map((m) => <StatusCard key={`${m.contractId}-${m.number}`} tone="red" title={`${t('ib_monthN', { n: m.number })} · ${naira(m.amount)}`} body={t('ib_missedNote')} />)}

      <SectionTitle>{t('ib_disputesTitle')}</SectionTitle>
      {b.disputedPayments.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {b.disputedPayments.map((d) => <StatusCard key={d.id} tone="red" title={naira(d.amount)} body={d.note ?? undefined} />)}

      <Sheet title={ask?.kind === 'release' ? t('ib_releasesTitle') : ask?.kind === 'appeal' ? t('ib_appealsTitle') : t('ib_mastersTitle')} visible={!!ask} onClose={() => setAsk(null)}>
        <View style={{ gap: 12 }}>
          {ask?.kind === 'appeal' && <Text style={s.body}>{ask.reason}</Text>}
          {ask?.kind === 'master' && <Text style={s.h3}>{ask.name}</Text>}
          <Field label={needNote ? t('ib_reason') : t('ib_noteOptional')} value={note} onChangeText={setNote} multiline maxLength={500} />
          <Button title={`✅ ${ask?.kind === 'appeal' ? t('ib_uphold') : t('ib_approve')}`} loading={busy} disabled={needNote && note.trim().length < 5} onPress={() => decide(true)} />
          <Button title={`✖️ ${ask?.kind === 'appeal' ? t('ib_dismiss') : t('ib_reject')}`} variant="danger" loading={busy} disabled={needNote && note.trim().length < 5} onPress={() => decide(false)} />
        </View>
      </Sheet>
    </Screen>
  );
}

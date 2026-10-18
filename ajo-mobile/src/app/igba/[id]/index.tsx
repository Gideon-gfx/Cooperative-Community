import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg, naira, uploadFile } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../../components/ui';
import { Field, SectionTitle } from '../../../components/widgets';
import { pickImage } from '../../../components/pickers';
import { downloadAndShare } from '../../../download';
import { LangToggle, ModeLabel, StatusCard, toneOfContract, useRefreshModule, type Contract, type Milestone } from '../../../components/igba';
import { colors, fonts } from '../../../theme';

const msTone = (st: string) => (st === 'APPROVED' ? 'green' : st === 'REJECTED' ? 'red' : 'yellow') as 'green' | 'yellow' | 'red';
type Ask = { kind: 'pause' | 'terminate' } | { kind: 'submit'; ms: Milestone } | null;

export default function AgreementDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const q = useQuery({ queryKey: ['contract', id], queryFn: async () => (await api.get<Contract>(`/contracts/${id}`)).data });
  const [ask, setAsk] = useState<Ask>(null);
  const [text, setText] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.isLoading || !q.data) return <Loading />;
  const c = q.data;
  const me = c.myRole;
  const isMaster = me === 'MASTER', isApprentice = me === 'APPRENTICE';
  const mustSign = c.status === 'PENDING_SIGNATURES' && !!me && c.waitingFor.includes(me);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); await refresh(); setAsk(null); setText(''); setProof(null); if (done) Alert.alert(t('ib_done'), done); }
    catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };
  const attach = async () => { const f = await pickImage(); if (f) { setBusy(true); try { setProof(await uploadFile(f)); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); } } };

  const confirmAsk = () => {
    if (!ask) return;
    if (ask.kind === 'submit') return run(() => api.patch(`/contracts/milestones/${ask.ms.id}/submit`, { ...(proof ? { evidenceUrl: proof } : {}), ...(text.trim() ? { note: text.trim() } : {}) }), t('ib_submittedForReview'));
    return run(() => api.post(`/contracts/${id}/${ask.kind}`, { reason: text.trim() }));
  };

  return (
    <Screen>
      <LangToggle />
      <StatusCard tone={toneOfContract(c.status)} title={`${c.tradeCategory} · ${t(`ib_status_${c.status}`)}`} body={c.statusReason ?? (mustSign ? t('ib_yourSignatureNeeded') : undefined)} speakText={`${c.tradeCategory}. ${t(`ib_status_${c.status}`)}`} />
      <ModeLabel mode="ESCROW" />

      <Card>
        <Text style={s.h3}>{t('ib_people')}</Text>
        {(['master', 'apprentice', 'guarantor', 'guardian'] as const).map((r) => c.parties[r] && (
          <View key={r} style={s.row}>
            <Text style={s.muted}>{t(`ib_role_${r.toUpperCase() === 'GUARDIAN' ? 'PARENT_GUARDIAN' : r.toUpperCase()}`)}</Text>
            <Text style={[s.body, { fontFamily: fonts.bodyBold }]}>{c.parties[r]!.name}</Text>
          </View>
        ))}
      </Card>
      <Card>
        <View style={s.row}><Text style={s.muted}>{t('ib_monthlySaving')}</Text><Text style={s.money}>{naira(c.monthlyContribution)}</Text></View>
        <View style={s.row}><Text style={s.muted}>{t('ib_target')}</Text><Text style={s.money}>{naira(c.targetSettlement)}</Text></View>
        {c.monthlyStipend !== null && <View style={s.row}><Text style={s.muted}>{t('ib_stipend')}</Text><Text style={s.money}>{naira(c.monthlyStipend)}</Text></View>}
        <View style={s.row}><Text style={s.muted}>{t('ib_duration')}</Text><Text style={s.body}>{t('ib_nMonths', { n: c.durationMonths })}</Text></View>
        {c.startDate && <View style={s.row}><Text style={s.muted}>{t('ib_started')}</Text><Text style={s.body}>{format(new Date(c.startDate), 'd MMM yyyy')}</Text></View>}
        <Text style={s.muted}>{t('ib_noInterest')}</Text>
      </Card>

      {c.status === 'PENDING_SIGNATURES' && (
        <Card>
          <Text style={s.h3}>{t('ib_signatures')}</Text>
          {c.signatures.map((x) => <Text key={x.role} style={s.body}>✅ {t(`ib_role_${x.role}`)} · {x.typedName}</Text>)}
          {c.waitingFor.map((r) => <Text key={r} style={s.body}>⏳ {t(`ib_role_${r}`)}</Text>)}
        </Card>
      )}

      {c.status === 'DRAFT' && isMaster && <Button title={t('ib_sendForSignatures')} loading={busy} onPress={() => run(() => api.post(`/contracts/${id}/send`))} />}
      {mustSign && <Button title={`✍️ ${t('ib_signNow')}`} onPress={() => router.push(`/igba/${id}/sign`)} />}
      {c.status === 'PENDING_SIGNATURES' && c.waitingFor.length === 0 && <Button title={t('ib_tryStart')} variant="accent" loading={busy} onPress={() => run(() => api.post(`/contracts/${id}/activate`))} />}

      <SectionTitle>{t('ib_milestones')}</SectionTitle>
      {c.milestones.length === 0 && <Text style={s.muted}>{t('ib_noMilestones')}</Text>}
      {c.milestones.map((m) => (
        <View key={m.id} style={{ gap: 6 }}>
          <StatusCard tone={msTone(m.status)} title={`${m.order}. ${m.title}`} body={`${t(`ib_ms_${m.status}`)} · ${format(new Date(m.dueDate), 'd MMM yyyy')}${m.reviewNote ? `\n💬 ${m.reviewNote}` : ''}`} />
          {isApprentice && c.status === 'ACTIVE' && m.status === 'NOT_STARTED' && <Button title={t('ib_startMilestone')} variant="outline" loading={busy} onPress={() => run(() => api.patch(`/contracts/milestones/${m.id}/start`))} />}
          {isApprentice && c.status === 'ACTIVE' && (m.status === 'IN_PROGRESS' || m.status === 'REJECTED') && <Button title={t('ib_submitMilestone')} onPress={() => setAsk({ kind: 'submit', ms: m })} />}
          {isMaster && m.status === 'SUBMITTED_FOR_REVIEW' && <Button title={t('ib_reviewNow')} variant="accent" onPress={() => router.push('/igba/review')} />}
        </View>
      ))}

      {c.status !== 'DRAFT' && <Button title={`📄 ${t('ib_downloadAgreement')}`} variant="outline" onPress={() => downloadAndShare(`/contracts/${id}/pdf`, `agreement-${id.slice(-6)}.pdf`, 'application/pdf').catch(() => Alert.alert(t('ib_error'), t('ib_downloadFailed')))} />}
      <Button title={`🙂 ${t('ib_conduct')}`} variant="outline" onPress={() => router.push(`/igba/${id}/conduct`)} />
      {c.startDate && <Button title={`🏦 ${t('ib_settlementFund')}`} variant="outline" onPress={() => router.push(`/igba/${id}/fund`)} />}
      {isMaster && c.status === 'ACTIVE' && <Button title={t('ib_pause')} variant="outline" onPress={() => setAsk({ kind: 'pause' })} />}
      {isMaster && c.status === 'PAUSED' && <Button title={t('ib_resume')} loading={busy} onPress={() => run(() => api.post(`/contracts/${id}/resume`))} />}
      {(isMaster || isApprentice) && (c.status === 'ACTIVE' || c.status === 'PAUSED') && <Button title={t('ib_terminate')} variant="danger" onPress={() => setAsk({ kind: 'terminate' })} />}

      <Card><Text style={s.h3}>{t('ib_terms')}</Text><Text style={s.body}>{c.termsAndConditions}</Text></Card>

      <Sheet title={ask?.kind === 'submit' ? t('ib_submitMilestone') : ask?.kind === 'pause' ? t('ib_pause') : t('ib_terminate')} visible={!!ask} onClose={() => setAsk(null)}>
        <View style={{ gap: 12 }}>
          {ask?.kind === 'terminate' && <Text style={{ color: colors.red, fontFamily: fonts.bodyBold }}>{t('ib_terminateWarn')}</Text>}
          <Field label={ask?.kind === 'submit' ? t('ib_noteOptional') : t('ib_reason')} value={text} onChangeText={setText} multiline maxLength={ask?.kind === 'submit' ? 500 : 300} />
          {ask?.kind === 'submit' && <Button title={proof ? `✅ ${t('ib_photoAdded')}` : `📷 ${t('ib_addPhoto')}`} variant="outline" loading={busy} onPress={attach} />}
          <Button title={t('ib_confirm')} variant={ask?.kind === 'terminate' ? 'danger' : 'primary'} loading={busy} disabled={ask?.kind !== 'submit' && text.trim().length < 5} onPress={confirmAsk} />
        </View>
      </Sheet>
    </Screen>
  );
}
